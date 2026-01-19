# VS Code DICOM Viewer with MPR

![DICOM Viewer Demo](https://raw.githubusercontent.com/digitrax1/vscode-dicom-viewer/main/docs/images/dicom-viewer-demo.png)

## 更新日志

- **v0.0.6**: 除了保留资源管理器右键快速加载外，启动时自动检查 Python 环境及 `pydicom`、`numpy`、`SimpleITK`、`vtk` 等依赖，不满足会弹窗提醒并阻止继续运行；远程环境下依然会通过 Base64 回退传输 DICOM 数据，确保图像不会因通道限制而丢失。
- **加速优化**：插件在处理DICOM/NIfTI文件、3D重建和分割可视化时进行了算法和数据流的加速优化，大幅提升加载与交互响应速度。
- **项目开源地址**：[https://github.com/digitrax1/vscode-dicom-viewer/tree/main](https://github.com/digitrax1/vscode-dicom-viewer/tree/main)

## 插件介绍

VS Code DICOM Viewer with MPR是一款功能强大的医学影像查看器插件，允许您在Visual Studio Code中直接查看和操作DICOM和NIfTI格式的医学图像文件。该插件提供多平面重建(MPR)、3D可视化、分割可视化等高级功能。

本插件是citrus-v项目开发过程中使用的工具之一，旨在为医学影像研究提供便捷的查看和分析工具，同时跟vscode结合可以轻松打开远程服务器的医学影像相关文件。

**相关链接：**
- citrus-v项目 repo：https://github.com/jd-opensource/Citrus-V
- citrus-v论文 arxiv：https://arxiv.org/abs/2509.19090

## 功能特点

### 📊 多平面重建 (MPR)
- **轴位视图**：显示横断面图像
- **矢状位视图**：显示前后方向的切面图像
- **冠状位视图**：显示左右方向的切面图像
- **3D视图**：提供三维重建视角和交互式3D模型


### 🛠️ 交互式操作工具
- **放大/缩小**：调整图像显示比例
- **平移**：移动图像查看不同区域
- **窗口/水平调整**：优化图像对比度和亮度
- **测量工具**：测量图像中的距离和角度
- **注释功能**：在图像上添加标记和注释
- **分割可视化**：支持分割标签的3D表面重建

### 🔧 高级功能
- **DICOM支持**：完整的DICOM文件读取和解析
- **NIfTI支持**：支持NIfTI格式的医学图像文件
- **分割处理**：支持医学图像分割数据的3D可视化
- **VTK集成**：基于VTK.js的高性能3D渲染
- **Python后端**：使用Python服务器处理复杂的医学图像数据

### ⚡ 高性能处理
- 基于Web Worker的后台处理，确保流畅的用户体验
- 支持大型DICOM和NIfTI数据集的快速加载和渲染
- 智能缓存机制，提高重复访问性能

## 安装方法

### 方法一：通过VSIX文件安装
1. 下载或生成`vscode-dicom-viewer-0.0.1.vsix`文件
2. 打开VS Code
3. 按下`Cmd+Shift+P` (macOS) 或 `Ctrl+Shift+P` (Windows/Linux) 打开命令面板
4. 输入并选择 "Extensions: Install from VSIX..."
5. 浏览并选择`.vsix`文件进行安装
6. 安装完成后重启VS Code以激活插件

### 方法二：从VS Code市场安装
<!-- 如果未来发布到市场 -->
1. 打开VS Code的扩展面板（`Cmd+Shift+X`或`Ctrl+Shift+X`）
2. 搜索 "VS Code DICOM Viewer"
3. 点击 "安装" 按钮
4. 重启VS Code以激活插件

## Python配置
这个插件的读图程序使用python驱动的，所以为了正常使用本插件，需要事先安装python环境
本插件需要Python环境来运行NIfTI服务器和3D可视化功能。默认使用`python3`命令。

### 配置Python路径
1. 打开VS Code设置（`Ctrl+,` 或 `Cmd+,`）
2. 搜索 "DICOM Viewer"
3. 在 "Python Path" 设置中配置Python可执行文件路径：
   - **Linux/Mac**: 默认 `python3`
   - **Windows**: 可能需要设置为 `python` 或完整路径如 `C:\Python39\python.exe`

### Python依赖
确保安装了以下Python包：
```bash
pip install -r requirements.txt
```

或者手动安装：
```bash
pip install pydicom numpy SimpleITK vtk
```

### 依赖说明
- **pydicom**: DICOM文件读取和解析
- **numpy**: 数值计算和数组处理
- **SimpleITK**: 医学图像处理和分析
- **vtk**: 3D可视化和表面重建

## 使用方式

### 1. 打开医学图像文件
- **DICOM文件**：在VS Code中打开包含DICOM文件的文件夹或单个DICOM文件
- **NIfTI文件**：直接打开.nii或.nii.gz格式的医学图像文件
- **分割文件**：支持加载医学图像分割数据用于3D可视化

#### 1.1 右键快速加载（新功能）
- 在资源管理器中右键单个`.dcm`文件或任何包含DICOM图像的文件夹，选择“Open DICOM Viewer”，即可直接打开面板并加载对应影像。
- 对`.nii`/`.nii.gz`文件也支持右键加载；若文件名中包含`seg`、`mask`、`label`等关键词，会自动识别为分割数据并加载分割图层，其它则作为普通NIfTI影像进入MPR界面。
- 如果查看器已经打开，右键加载时会复用当前面板并刷新为新数据，无需手动重新启动。

### 2. 启动DICOM查看器
- 按下`Cmd+Shift+P` (macOS) 或 `Ctrl+Shift+P` (Windows/Linux)
- 输入并选择 "DICOM Viewer: Open DICOM Viewer"
- 插件将启动Python后端服务器并打开Webview面板

### 3. 多平面重建操作
- **视图切换**：在轴位、矢状位、冠状位视图间切换
- **交互操作**：使用鼠标进行放大、缩小、平移
- **窗口调整**：调整窗宽窗位以优化图像显示
- **同步浏览**：多个视图同步显示相同位置

### 4. 3D可视化功能
- **3D重建**：从DICOM序列生成3D模型
- **分割可视化**：将分割标签转换为3D表面网格
- **交互式3D**：旋转、缩放、平移3D模型
- **多标签支持**：同时显示多个分割结构

### 5. 高级功能
- **测量工具**：测量距离、角度等几何参数
- **注释功能**：在图像上添加标记和注释
- **导出功能**：导出3D模型为OBJ格式

## 技术规格

### 前端技术
- **开发语言**：TypeScript
- **核心库**：Cornerstone.js, dicom-parser, VTK.js
- **3D渲染**：VTK.js for WebGL-based 3D visualization
- **图像处理**：Cornerstone.js for DICOM image rendering

### 后端技术
- **开发语言**：Python
- **核心库**：pydicom, SimpleITK, VTK, numpy
- **服务器**：HTTP服务器，支持RESTful API
- **缓存机制**：智能缓存，提高重复访问性能

### 支持格式
- **DICOM格式**：大多数标准DICOM图像格式
- **NIfTI格式**：.nii, .nii.gz文件
- **分割数据**：支持医学图像分割标签
- **导出格式**：OBJ格式3D模型

### 兼容性
- **VS Code版本**：1.80.0及以上版本
- **Python版本**：3.7及以上版本
- **浏览器支持**：现代浏览器（支持WebGL）

## 注意事项

### 性能要求
- 对于特别大型的DICOM数据集，首次加载可能需要一些时间
- 为获得最佳性能，建议在现代多核处理器和足够内存的环境下使用
- 3D可视化需要支持WebGL的现代浏览器

### 系统要求
- **内存**：建议8GB以上内存用于大型数据集处理
- **显卡**：支持WebGL的显卡，用于3D渲染
- **Python环境**：需要正确配置Python路径和依赖

### 已知限制
- 当前版本专注于DICOM和NIfTI格式的查看和基本分析
- 复杂的医学图像后处理功能正在开发中
- 某些特殊的DICOM私有标签可能不被完全支持

## 开发与构建

### 构建插件
使用提供的构建脚本：
```bash
chmod +x build.sh
./build.sh
```

### 开发环境设置
1. 克隆项目到本地
2. 安装Node.js依赖：`npm install`
3. 安装Python依赖：`pip install -r requirements.txt`
4. 编译TypeScript：`npm run compile`
5. 在VS Code中按F5启动调试

### 项目结构
```
src/
├── extension.ts          # 主扩展文件
├── nifti_server.py       # Python后端服务器
├── nifti_reader.py       # NIfTI文件读取器
├── vtk_segmentation.py   # VTK分割处理
└── seg_to_vtp.py         # 分割转VTP格式

docs/
└── images/               # 文档图片目录
    └── dicom-viewer-demo.png      # 插件主界面演示
```

## 图片资源

README中使用的图片资源位于 `docs/images/` 目录中。如需更新图片，请参考 `docs/images/README.md` 中的详细说明。

## 开发与贡献
如果您发现任何问题或有改进建议，欢迎提交Issue或Pull Request。

## License
MIT License

## 致谢
本插件基于以下开源项目构建：
- [Cornerstone.js](https://cornerstonejs.org/) - DICOM图像渲染
- [dicom-parser](https://github.com/cornerstonejs/dicom-parser) - DICOM文件解析
- [VTK.js](https://kitware.github.io/vtk-js/) - 3D可视化和渲染
- [SimpleITK](https://simpleitk.org/) - 医学图像处理
- [pydicom](https://pydicom.github.io/) - Python DICOM处理
- [VS Code Extension API](https://code.visualstudio.com/api) - VS Code扩展开发