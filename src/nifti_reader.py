import sys
import json
import math
import numpy as np
import SimpleITK as sitk
import base64
import os
from pathlib import Path

def read_dicom_folder(folder: str):
    folder = Path(folder)
    if not folder.is_dir():
        raise ValueError(f"{folder} is not a directory")
    reader = sitk.ImageSeriesReader()
    # 1. 获取目录下所有 series UID
    series_uid_all = reader.GetGDCMSeriesIDs(str(folder))
    if not series_uid_all:
        raise RuntimeError("no valid DICOM series found")
    # 2. 只保留第一个 series
    first_uid = series_uid_all[0]
    # 3. 取得该 series 的所有文件名（已按几何顺序排好）
    dicom_names = reader.GetGDCMSeriesFileNames(str(folder), first_uid)
    reader.SetFileNames(dicom_names)
    reader.LoadPrivateTagsOn()
    image_sitk: sitk.Image = reader.Execute()
    return image_sitk

def _to_serializable(obj):
    """Recursively convert objects to JSON-serializable structures."""
    try:
        # numpy arrays -> list (recursively processed)
        if isinstance(obj, np.ndarray):
            return _to_serializable(obj.tolist())
        # numpy scalar -> Python scalar
        if isinstance(obj, np.generic):
            val = obj.item()
            # fall through to regular handling below
            obj = val
        # plain float special cases (NaN/Inf) -> None
        if isinstance(obj, float):
            if math.isnan(obj) or math.isinf(obj):
                return None
            return obj
        # bytes-like -> utf-8 (fallback to latin1), or base64 if decode fails
        if isinstance(obj, (bytes, bytearray, memoryview)):
            try:
                return bytes(obj).decode('utf-8', errors='ignore')
            except Exception:
                try:
                    return bytes(obj).decode('latin1', errors='ignore')
                except Exception:
                    return base64.b64encode(bytes(obj)).decode('utf-8')
        # containers -> recurse
        if isinstance(obj, dict):
            return {str(k): _to_serializable(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [_to_serializable(v) for v in obj]
        # primitives or already serializable
        json.dumps(obj)
        return obj
    except Exception:
        # last-resort string conversion
        try:
            return str(obj)
        except Exception:
            return repr(obj)


def _window_slice_to_uint8(slice_data: np.ndarray, window_center: float | None, window_width: float | None) -> np.ndarray:
    """Apply windowing (center/width) to a 2D slice and return uint8 image.

    If window params are not provided or invalid, falls back to min-max normalization.
    """
    try:
        if window_center is not None and window_width is not None and window_width > 0:
            lower = float(window_center) - float(window_width) / 2.0
            upper = float(window_center) + float(window_width) / 2.0
            if upper <= lower:
                # degenerate window, fallback to min-max
                raise ValueError("Invalid window range")
            scaled = (slice_data - lower) / (upper - lower)
            clipped = np.clip(scaled, 0.0, 1.0)
            return (clipped * 255.0).astype(np.uint8)
    except Exception:
        # fall through to min-max normalization on any error
        pass

    # Min-max normalization fallback
    min_val = float(np.min(slice_data))
    max_val = float(np.max(slice_data))
    if max_val - min_val > 0:
        normalized = 255.0 * ((slice_data - min_val) / (max_val - min_val))
    else:
        normalized = np.zeros_like(slice_data)
    return normalized.astype(np.uint8)


def _encode_slice(slice_data: np.ndarray, window_center: float | None = None, window_width: float | None = None, seg_mode: bool = False) -> dict:
    if seg_mode:
        # For segmentation masks, return raw labels as uint8 without windowing
        uint8_data = slice_data.astype(np.uint8, copy=False)
    else:
        uint8_data = _window_slice_to_uint8(slice_data, window_center, window_width)
    pixel_data = base64.b64encode(uint8_data.tobytes()).decode('utf-8')
    rows, cols = uint8_data.shape[0], uint8_data.shape[1]
    return {
        "pixelData": pixel_data,
        "rows": rows,
        "columns": cols,
    }


class NiftiReader:
    """Reader that loads a NIfTI file once and serves slices without re-reading."""

    def __init__(self, file_path: str) -> None:
        # Load once
        self.file_path = file_path
        if file_path.endswith('.nii.gz') or file_path.endswith('.nii'):
            self.img = sitk.ReadImage(file_path)
            data = sitk.GetArrayFromImage(self.img)  # returns array with shape (z, y, x)
        elif os.path.isdir(file_path):
            self.img = read_dicom_folder(file_path)
            data = sitk.GetArrayFromImage(self.img)  # returns array with shape (z, y, x)
        else:
            try:
                # 尝试读取单个DICOM文件或其他SimpleITK支持的格式
                self.img = sitk.ReadImage(file_path)
                data = sitk.GetArrayFromImage(self.img)
            except Exception as exc:
                raise ValueError(f"Unsupported file type: {file_path}") from exc

        # Handle 4D by taking first timepoint if present: (t, z, y, x) -> (z, y, x)
        if data.ndim == 4:
            data = data[0]

        # Reorder to (x, y, z) to match previous nibabel-based conventions
        data_xyz = np.transpose(data, (2, 1, 0))
        data_xyz = data_xyz[:, :, ::-1]
        self.data: np.ndarray = data_xyz
        self.shape = self.data.shape

        # Build an affine-like 4x4 from SimpleITK metadata (origin, spacing, direction)
        spacing = list(self.img.GetSpacing())  # (x, y, z)
        origin = list(self.img.GetOrigin())    # (x, y, z)
        direction = list(self.img.GetDirection())  # 9 elements row-major for 3D
        # Compose 3x3 direction matrix scaled by spacing
        dir_mat = np.array(direction, dtype=float).reshape(3, 3)
        scaled = dir_mat @ np.diag(spacing)
        affine = np.eye(4, dtype=float)
        affine[:3, :3] = scaled
        affine[:3, 3] = np.array(origin, dtype=float)
        self.affine = affine.tolist()

        # Craft a minimal header compatible with previous keys
        # Note: SimpleITK doesn't expose NIfTI header fields directly; we approximate
        self.serializable_header = _to_serializable({
            'dim': [self.shape[0], self.shape[1], self.shape[2]],
            'pixdim': [spacing[0], spacing[1], spacing[2]],
        })

    def build_result(
        self,
        slice_index: int | None = None,
        plane: str | None = None,
        window_center: float | None = None,
        window_width: float | None = None,
        seg_mode: bool = False,
    ) -> dict:
        shape = self.shape
        data = self.data

        if len(shape) < 3:
            return {
                "success": False,
                "error": f"Unsupported data dimensions: {shape}"
            }

        # All three mid-slices (or provided axial index) if plane is None or 'all'
        if plane is None or str(plane).lower() == 'all':
            xmid = int(shape[0] // 2)
            ymid = int(shape[1] // 2)
            zmid = int(shape[2] // 2 if slice_index is None else max(0, min(shape[2] - 1, int(slice_index))))

            axial = _encode_slice(data[:, :, zmid].T, window_center, window_width, seg_mode)
            sagittal = _encode_slice(data[xmid, :, :].T, window_center, window_width, seg_mode)
            coronal = _encode_slice(data[:, ymid, :].T, window_center, window_width, seg_mode)

            return {
                "success": True,
                "metadata": {
                    "shape": list(shape),
                    "affine": self.affine,
                    "header": self.serializable_header,
                },
                "axial": { **axial, "sliceIndex": zmid },
                "sagittal": { **sagittal, "sliceIndex": xmid },
                "coronal": { **coronal, "sliceIndex": ymid },
                "window": None if seg_mode else { "center": window_center, "width": window_width },
                "slices": {
                    "axial": shape[2],
                    "sagittal": shape[0],
                    "coronal": shape[1],
                },
            }

        # Single plane request
        p = str(plane).lower()
        if p == 'axial':
            max_idx = shape[2]
            idx = int(max(0, min(max_idx - 1, 0 if slice_index is None else int(slice_index))))
            enc = _encode_slice(data[:, :, idx].T, window_center, window_width, seg_mode)
        elif p == 'sagittal':
            max_idx = shape[0]
            idx = int(max(0, min(max_idx - 1, 0 if slice_index is None else int(slice_index))))
            enc = _encode_slice(data[idx, :, :].T, window_center, window_width, seg_mode)
        elif p == 'coronal':
            max_idx = shape[1]
            idx = int(max(0, min(max_idx - 1, 0 if slice_index is None else int(slice_index))))
            enc = _encode_slice(data[:, idx, :].T, window_center, window_width, seg_mode)
        else:
            return {"success": False, "error": f"Unknown plane: {plane}"}

        return {
            "success": True,
            "metadata": {
                "shape": list(shape),
                "affine": self.affine,
                "header": self.serializable_header,
            },
            "plane": p,
            **enc,
            "sliceIndex": idx,
            "window": None if seg_mode else { "center": window_center, "width": window_width },
            "slices": {
                "axial": shape[2],
                "sagittal": shape[0],
                "coronal": shape[1],
            },
        }


def read_nifti_file(file_path, slice_index=None, plane: str | None = None, window_center: float | None = None, window_width: float | None = None, seg_mode: bool = False):
    try:
        reader = NiftiReader(file_path)
        result = reader.build_result(slice_index, plane, window_center, window_width, seg_mode)
        print(json.dumps(result))
    except Exception as e:
        error = {
            "success": False,
            "error": str(e)
        }
        print(json.dumps(error))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # args: file, [sliceIndex], [plane], [windowCenter], [windowWidth], [seg]
        idx = None
        pl = None
        wc = None
        ww = None
        seg_flag = False
        if len(sys.argv) > 2:
            try:
                idx = int(sys.argv[2])
            except Exception:
                idx = None
        if len(sys.argv) > 3:
            pl = sys.argv[3]
        if len(sys.argv) > 4:
            try:
                wc = float(sys.argv[4])
            except Exception:
                wc = None
        if len(sys.argv) > 5:
            try:
                ww = float(sys.argv[5])
            except Exception:
                ww = None
        if len(sys.argv) > 6:
            seg_flag = str(sys.argv[6]).strip().lower() in ("seg", "1", "true", "yes")
        read_nifti_file(sys.argv[1], idx, pl, wc, ww, seg_flag)
    else:
        error = {
            "success": False,
            "error": "No file path provided"
        }
        print(json.dumps(error))