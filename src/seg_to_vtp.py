import sys
import json
from typing import Iterable, Optional
import contextlib
import io


def seg_to_vtp(segmentation_path: str, output_dir: Optional[str] = None, label_values: Optional[Iterable[int]] = None) -> dict:
    """
    将分割文件转换为 VTP 网格文件。

    支持 SimpleITK 可读取的分割体素文件（如 .nii/.nii.gz/.nrrd/.mha 等）。
    会为每个非零标签生成独立的 .vtp 文件，并在可能时生成一个合并的 .vtp 文件。

    Args:
        segmentation_path: 分割文件路径
        output_dir: 输出目录，默认同输入文件目录
        label_values: 指定需要导出的标签值（不传则导出所有非零标签）

    Returns:
        dict: 处理结果（JSON 可序列化）
    """
    # 复用现有实现，保持逻辑一致
    try:
        from vtk_segmentation import create_vtp_from_segmentation
    except Exception as import_error:
        return {
            "success": False,
            "error": f"Import error: {import_error}",
            "segmentation_file": segmentation_path,
        }

    try:
        # Suppress any stdout produced inside create_vtp_from_segmentation to keep output JSON-clean
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink):
            return create_vtp_from_segmentation(
                segmentation_path,
                output_dir,
                list(label_values) if label_values is not None else None,
            )
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "segmentation_file": segmentation_path,
        }


def _parse_label_values(arg: str) -> list[int]:
    parts = [p.strip() for p in str(arg).split(',') if str(p).strip()]
    values: list[int] = []
    for p in parts:
        try:
            values.append(int(p))
        except Exception:
            # 跳过非法条目
            continue
    return values


def main() -> None:
    if len(sys.argv) < 2:
        error = {
            "success": False,
            "error": "Usage: python seg_to_vtp.py <seg_file> [output_dir] [label_values]",
        }
        print(json.dumps(error))
        return

    seg_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    label_values = _parse_label_values(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None

    result = seg_to_vtp(seg_file, output_dir, label_values)
    print(json.dumps(result))


if __name__ == "__main__":
    main()


