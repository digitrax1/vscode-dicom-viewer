from io import RawIOBase
import sys
import json
import numpy as np
import SimpleITK as sitk
import vtk
from vtk.util import numpy_support
import os


def create_vtp_from_segmentation(segmentation_path, output_dir=None, label_values=None):
    """
    从分割NIfTI文件创建表面网格，仅生成OBJ文件。
    
    Args:
        segmentation_path: 分割NIfTI文件路径
        output_dir: 输出文件的目录，如果为None则使用分割文件所在目录
        label_values: 要处理的标签值列表，如果为None则处理所有非零标签
    
    Returns:
        dict: 包含生成的OBJ文件路径和元数据的结果
    """
    try:
        # 读取分割图像
        seg_img = sitk.ReadImage(segmentation_path)
        seg_data = sitk.GetArrayFromImage(seg_img)  # (z, y, x)
        
        # 获取图像信息和变换矩阵
        spacing = seg_img.GetSpacing()
        origin = seg_img.GetOrigin()
        direction = seg_img.GetDirection()
        
        # 创建VTK图像数据
        vtk_image = vtk.vtkImageData()
        vtk_image.SetDimensions(seg_data.shape[2], seg_data.shape[1], seg_data.shape[0])
        vtk_image.SetSpacing(spacing[0], spacing[1], spacing[2])
        vtk_image.SetOrigin(origin[0], origin[1], origin[2])
        
        # 将分割数据转换为VTK格式
        seg_data_vtk = numpy_support.numpy_to_vtk(
            seg_data.flatten(),  # Fortran order for VTK
            deep=True,
            array_type=vtk.VTK_UNSIGNED_CHAR
        )
        seg_data_vtk.SetName('LabelMap')
        vtk_image.GetPointData().SetScalars(seg_data_vtk)
        
        # 如果没有指定输出目录，使用分割文件所在目录
        if output_dir is None:
            output_dir = os.path.dirname(segmentation_path)
        
        # 确保输出目录存在
        os.makedirs(output_dir, exist_ok=True)
        
        # 清理输出目录中之前的OBJ文件
        try:
            for existing_file in os.listdir(output_dir):
                if existing_file.endswith('.obj') and existing_file.startswith('label_'):
                    os.remove(os.path.join(output_dir, existing_file))
        except Exception as e:
            print(f"Warning: Could not clean previous OBJ files: {e}", file=sys.stderr)
        
        # 获取唯一标签值
        unique_labels = np.unique(seg_data)
        unique_labels = unique_labels[unique_labels > 0]  # 排除背景
        
        # 定义与extension相同的颜色方案
        seg_colors = [
            [255, 0, 0],      # Red
            [0, 255, 0],      # Green  
            [0, 0, 255],      # Blue
            [255, 255, 0],    # Yellow
            [255, 0, 255],    # Magenta
            [0, 255, 255],    # Cyan
            [255, 128, 0],    # Orange
            [128, 0, 255]     # Purple
        ]
        
        if label_values is not None:
            unique_labels = np.intersect1d(unique_labels, label_values)
        
        generated_files = []
        metadata = {
            "spacing": spacing,
            "origin": origin,
            "dimensions": seg_data.shape,
            "unique_labels": unique_labels.tolist()
        }
        
        # 为每个标签生成OBJ文件
        for label in unique_labels:
            try:
                # 关键修复: 精确提取单个标签的体素
                # 问题: 直接使用SetValue(0, float(label))会渲染所有>=label的体素
                # 解决: 先创建二值化图像，只保留等于当前标签的体素
                threshold = vtk.vtkImageThreshold()
                threshold.SetInputData(vtk_image)
                threshold.ThresholdBetween(float(label), float(label))  # 精确匹配: 只保留值==label的体素
                threshold.SetInValue(1.0)   # 匹配的体素 -> 1
                threshold.SetOutValue(0.0)  # 其他体素 -> 0
                threshold.Update()
                
                # 现在在二值化图像(0,1)上运行Marching Cubes
                marching_cubes = vtk.vtkMarchingCubes()
                marching_cubes.SetInputData(threshold.GetOutput())
                marching_cubes.SetValue(0, 0.5)  # 等值面在0和1之间，精确提取label边界
                marching_cubes.Update()
                
                # 获取生成的网格
                mesh = marching_cubes.GetOutput()
                
                if mesh.GetNumberOfPoints() == 0:
                    continue
                
                # 应用平滑滤波器
                smoother = vtk.vtkSmoothPolyDataFilter()
                smoother.SetInputConnection(marching_cubes.GetOutputPort())
                smoother.SetNumberOfIterations(50)
                smoother.SetRelaxationFactor(0.1)
                smoother.FeatureEdgeSmoothingOff()
                smoother.BoundarySmoothingOn()
                smoother.Update()
                
                # 计算法向量
                normals = vtk.vtkPolyDataNormals()
                normals.SetInputConnection(smoother.GetOutputPort())
                normals.ComputePointNormalsOn()
                normals.ComputeCellNormalsOn()
                normals.ConsistencyOn()
                normals.AutoOrientNormalsOn()
                normals.Update()
                
                # 创建最终网格
                final_mesh = normals.GetOutput()
                # 生成输出文件名（仅OBJ）
                base_name = os.path.splitext(os.path.basename(segmentation_path))[0]
                if base_name.endswith('.nii'):
                    base_name = base_name[:-4]
                
                # 写入OBJ文件 - 使用指定的output_dir
                obj_filename = f"label_{int(label)}.obj"
                obj_path = os.path.join(os.path.dirname(__file__), obj_filename)
                try:
                    # 为每个标签设置颜色
                    color_idx = (int(label) - 1) % len(seg_colors)
                    color = seg_colors[color_idx]
                    r, g, b = color[0]/255.0, color[1]/255.0, color[2]/255.0
                    
                    # 创建带颜色的OBJ文件
                    obj_writer = vtk.vtkOBJWriter()
                    obj_writer.SetFileName(obj_path)
                    obj_writer.SetInputData(final_mesh)
                    obj_writer.Write()
                    
                    obj_info = {
                        "label": int(label),
                        "filename": obj_filename,
                        "path": obj_path,
                        "points": final_mesh.GetNumberOfPoints(),
                        "cells": final_mesh.GetNumberOfCells(),
                        "format": "obj",
                        "color": [r, g, b]  # 添加颜色信息
                    }
                    generated_files.append(obj_info)
                except Exception as e:
                    print(f"Error writing OBJ for label {label}: {str(e)}", file=sys.stderr)
                
            except Exception as e:
                print(f"Error processing label {label}: {str(e)}", file=sys.stderr)
                continue
        
        result = {
            "success": True,
            "segmentation_file": segmentation_path,
            "output_directory": output_dir,
            "generated_files": generated_files,
            "metadata": metadata,
            "total_labels": len(unique_labels),
            "total_files": len(generated_files)
        }
        
        return result
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "segmentation_file": segmentation_path
        }


def main():
    # 可选显示标志：通过命令行 --show / -s 或环境变量 SHOW_VTK=1 启用
    # show_vtk = any(arg in ("--show", "-s") for arg in sys.argv[1:]) or os.getenv("SHOW_VTK", "").lower() in ("1", "true", "yes", "y")

        # print (show_vtk)
        # raise

    show_vtk = True
    # 过滤掉显示标志，保留位置参数以保持向后兼容
    args_no_flags = [a for a in sys.argv[1:] if a not in ("--show", "-s")]

    if len(args_no_flags) < 1:
        error = {
            "success": False,
            "error": "Usage: python vtk_segmentation.py <segmentation_file> [output_dir] [label_values] [--show]"
        }
        print(json.dumps(error))
        return

    segmentation_file = args_no_flags[0]
    output_dir = args_no_flags[1] if len(args_no_flags) > 1 else None

    # 解析标签值（可选）
    label_values = None
    if len(args_no_flags) > 2:
        try:
            label_values = [int(x.strip()) for x in args_no_flags[2].split(',') if x.strip()]
        except ValueError:
            print("Warning: Invalid label values format, processing all labels", file=sys.stderr)

    result = create_vtp_from_segmentation(segmentation_file, output_dir, label_values)

    # 如需显示，使用VTK进行可视化（优先显示combined.vtp，否则显示各标签的vtp）
    try:
        if show_vtk and result.get("success"):
            def _visualize_with_vtk(generated_files):
                # 选择渲染目标
                combined_entry = next((f for f in generated_files if str(f.get("label")) == "combined" and f.get("format") == "vtp"), None)
                entries_to_render = []
                if combined_entry is not None:
                    entries_to_render = [combined_entry]
                else:
                    entries_to_render = [f for f in generated_files if f.get("format") == "vtp"]
                    if not entries_to_render:
                        # 回退到 OBJ（如果没有 VTP）
                        entries_to_render = [f for f in generated_files if f.get("format") == "obj"]

                if not entries_to_render:
                    print("No VTP/OBJ files to render.", file=sys.stderr)
                    return

                colors = vtk.vtkNamedColors()
                renderer = vtk.vtkRenderer()
                render_window = vtk.vtkRenderWindow()
                render_window.AddRenderer(renderer)
                interactor = vtk.vtkRenderWindowInteractor()
                interactor.SetRenderWindow(render_window)

                # 背景色
                try:
                    renderer.SetBackground(colors.GetColor3d("SlateGray"))
                except Exception:
                    renderer.SetBackground(0.2, 0.2, 0.25)

                # 使用与extension相同的颜色方案 (RGB 0-255 -> 0-1)
                seg_colors = [
                    [255, 0, 0],      # Red
                    [0, 255, 0],      # Green  
                    [0, 0, 255],      # Blue
                    [255, 255, 0],    # Yellow
                    [255, 0, 255],    # Magenta
                    [0, 255, 255],    # Cyan
                    [255, 128, 0],    # Orange
                    [128, 0, 255]     # Purple
                ]

                for idx, entry in enumerate(entries_to_render):
                    path = entry.get("path")
                    fmt = entry.get("format")
                    if not path or not os.path.exists(path):
                        continue

                    if fmt == "vtp":
                        reader = vtk.vtkXMLPolyDataReader()
                        reader.SetFileName(path)
                        reader.Update()
                        polydata = reader.GetOutput()
                    elif fmt == "obj":
                        reader = vtk.vtkOBJReader()
                        reader.SetFileName(path)
                        reader.Update()
                        polydata = reader.GetOutput()
                    else:
                        continue

                    mapper = vtk.vtkPolyDataMapper()
                    mapper.SetInputData(polydata)
                    actor = vtk.vtkActor()
                    actor.SetMapper(mapper)

                    # 颜色设置 - 使用与extension相同的颜色
                    label_str = str(entry.get("label"))
                    if label_str == "combined":
                        # 组合文件使用金色
                        actor.GetProperty().SetColor(1.0, 0.84, 0.0)  # Gold
                    else:
                        # 根据标签值选择颜色
                        try:
                            label_val = int(label_str)
                            color_idx = (label_val - 1) % len(seg_colors)
                            color = seg_colors[color_idx]
                            # 转换为0-1范围
                            r, g, b = color[0]/255.0, color[1]/255.0, color[2]/255.0
                            actor.GetProperty().SetColor(r, g, b)
                        except (ValueError, IndexError):
                            # 回退到默认颜色
                            actor.GetProperty().SetColor(0.8, 0.8, 0.8)
                    actor.GetProperty().SetOpacity(1.0 if label_str == "combined" else 0.85)

                    renderer.AddActor(actor)

                renderer.ResetCamera()
                render_window.SetSize(960, 720)
                interactor.Initialize()
                render_window.Render()
                interactor.Start()

            _visualize_with_vtk(result.get("generated_files", []))
    except Exception as viz_err:
        print(f"Error visualizing with VTK: {str(viz_err)}", file=sys.stderr)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
