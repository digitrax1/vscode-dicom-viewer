
# 设置脚本在遇到错误时立即退出
set -e

# 打印当前操作
echo "==================== VS Code DICOM Viewer 构建脚本 ===================="

# 1. 安装项目依赖
echo -e "\n[1/3] 正在安装项目依赖..."
npm install

# 2. 编译TypeScript代码
echo -e "\n[2/3] 正在编译TypeScript代码..."
npx tsc

# 检查编译是否成功
if [ $? -eq 0 ]; then
echo "✅ TypeScript编译成功！"
else
echo "❌ TypeScript编译失败，请检查错误信息。"
exit 1
fi

# 3. 安装VS Code打包工具（新版本）
echo -e "\n[3/3] 正在安装VS Code打包工具..."
# 先尝试卸载旧版本（如果存在）
npm uninstall -g vsce 2>/dev/null || true
# 安装新版本
npm install -g @vscode/vsce

# 4. 打包插件成VSIX文件
echo -e "\n[4/4] 正在打包插件..."
vsce package

# 检查打包是否成功
if [ $? -eq 0 ]; then
echo -e "\n✅ 插件打包成功！"
echo -e "\n🎉 VS Code DICOM Viewer 构建完成！\n"
echo "请在当前目录查找生成的 .vsix 文件，使用以下步骤安装："
echo "1. 打开VS Code"
echo "2. 按下 Cmd+Shift+P 并选择 'Extensions: Install from VSIX...'"
echo "3. 选择生成的 .vsix 文件"
echo -e "4. 重启VS Code以激活插件\n"
else
echo "❌ 插件打包失败，请检查错误信息。"
exit 1
fi