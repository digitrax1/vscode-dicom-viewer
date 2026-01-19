import pydicom
import sys
import json
import numpy as np
import base64

def read_dicom_file(file_path):
    try:
        # 读取DICOM文件
        ds = pydicom.dcmread(file_path)
        
        # 提取图像数据
        pixel_array = ds.pixel_array.tolist()
        
        # 获取元数据
        metadata = {
            "PatientName": str(ds.PatientName) if hasattr(ds, 'PatientName') else "Unknown",
            "StudyDate": str(ds.StudyDate) if hasattr(ds, 'StudyDate') else "Unknown",
            "StudyDescription": str(ds.StudyDescription) if hasattr(ds, 'StudyDescription') else "Unknown",
            "Modality": str(ds.Modality) if hasattr(ds, 'Modality') else "Unknown",
            "Rows": ds.Rows if hasattr(ds, 'Rows') else 0,
            "Columns": ds.Columns if hasattr(ds, 'Columns') else 0
        }
        
        # 将像素数据转换为Base64以方便JavaScript处理
        # 注意：这里简化了处理，实际项目中可能需要根据实际情况优化
        pixel_data = base64.b64encode(np.array(pixel_array).tobytes()).decode('utf-8')
        
        result = {
            "success": True,
            "metadata": metadata,
            "pixelData": pixel_data,
            "rows": metadata["Rows"],
            "columns": metadata["Columns"]
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        error = {
            "success": False,
            "error": str(e)
        }
        print(json.dumps(error))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        read_dicom_file(sys.argv[1])
    else:
        error = {
            "success": False,
            "error": "No file path provided"
        }
        print(json.dumps(error))