import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let panel: vscode.WebviewPanel | undefined = undefined;
// 添加输出通道
const outputChannel = vscode.window.createOutputChannel('DICOM Viewer with MPR');
let extensionBasePath: string | undefined;
const requiredPythonModules = ['pydicom', 'numpy', 'SimpleITK', 'vtk'];
let pythonEnvVerified = false;
let pythonEnvCheckPromise: Promise<void> | undefined;

function isUriLike(value: unknown): value is vscode.Uri {
    return !!value && typeof value === 'object' && typeof (value as { fsPath?: unknown }).fsPath === 'string';
}

function normalizeCommandUris(value?: vscode.Uri | readonly vscode.Uri[]): vscode.Uri[] {
    if (!value) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.filter(isUriLike);
    }
    return isUriLike(value) ? [value] : [];
}

async function ensurePythonEnvironment(): Promise<void> {
    if (pythonEnvVerified) {
        return;
    }
    if (pythonEnvCheckPromise) {
        return pythonEnvCheckPromise;
    }

    const pythonPath = getPreferredPythonPath();
    const { spawn } = require('child_process');
    const script = `
import importlib, sys
modules = ${JSON.stringify(requiredPythonModules)}
missing = []
for module in modules:
    try:
        importlib.import_module(module)
    except Exception as exc:
        missing.append(f"{module}: {exc}")
if missing:
    sys.stderr.write("missing:" + "\\n".join(missing))
    sys.exit(1)
print("python-env-ok")
`;

    pythonEnvCheckPromise = new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const proc = spawn(pythonPath, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        const resolvedPythonPath = proc.spawnfile || pythonPath;
        outputChannel.appendLine(`[python] verifying interpreter at ${resolvedPythonPath}`);
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.on('error', (err: Error) => {
            pythonEnvCheckPromise = undefined;
            reject(new Error(`[${resolvedPythonPath}] ${err.message}`));
        });
        proc.on('close', (code: number) => {
            pythonEnvCheckPromise = undefined;
            if (code === 0) {
                pythonEnvVerified = true;
                outputChannel.appendLine(`[python] Environment verified (${resolvedPythonPath}): ${stdout.trim()}`);
                resolve();
            } else {
                const message = stderr.trim() || `python exited with code ${code}`;
                reject(new Error(`[${resolvedPythonPath}] ${message}`));
            }
        });
    });

    return pythonEnvCheckPromise;
}

function isNiftiPath(filePath: string): boolean {
    const normalized = filePath.toLowerCase();
    return normalized.endsWith('.nii') || normalized.endsWith('.nii.gz');
}

function isSegmentationPath(filePath: string): boolean {
    if (!isNiftiPath(filePath)) {
        return false;
    }
    const name = path.basename(filePath).toLowerCase();
    const indicators = ['seg', 'segmentation', 'mask', 'label'];
    return indicators.some(indicator => name.includes(indicator));
}

// NIfTI server process management
let niftiServerProc: any | undefined;
let niftiServerPort: number | undefined;
let niftiServerStarting: Promise<number> | undefined;

async function ensureNiftiServer(): Promise<number> {
    if (typeof niftiServerPort === 'number') return niftiServerPort;
    if (niftiServerStarting) return niftiServerStarting;
    await ensurePythonEnvironment();
    const { spawn } = require('child_process');
    const nodePath = require('path');
    const basePath = extensionBasePath ?? __dirname;
    const scriptPath = nodePath.join(basePath, 'src', 'nifti_server.py');
    // Get Python path from VS Code settings, default to 'python3'
    const pythonPath = getPreferredPythonPath();
    
    outputChannel.appendLine(`[nifti-server] Python path from config: "${pythonPath}"`);
    outputChannel.appendLine(`[nifti-server] Script path: "${scriptPath}"`);
    outputChannel.appendLine(`[nifti-server] starting: ${pythonPath} ${scriptPath}`);
    niftiServerStarting = new Promise<number>((resolve, reject) => {
        try {
            const args = ['--host', '127.0.0.1', '--port', '0'];
            const proc = spawn(pythonPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
            niftiServerProc = proc;
            let buffered = '';
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (chunk: string) => {
                buffered += String(chunk);
                let idx: number;
                while ((idx = buffered.indexOf('\n')) >= 0) {
                    const line = buffered.slice(0, idx).trim();
                    buffered = buffered.slice(idx + 1);
                    if (line.startsWith('READY ')) {
                        const portStr = line.split(' ')[1];
                        const port = Number(portStr);
                        if (!Number.isNaN(port) && port > 0) {
                            niftiServerPort = port;
                            outputChannel.appendLine(`[nifti-server] ready on port ${port}`);
                            resolve(port);
                        }
                    }
                }
            });
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (s: string) => {
                outputChannel.appendLine(`[nifti-server stderr] ${s.substring(0, 512)}${s.length > 512 ? '…' : ''}`);
            });
            proc.on('exit', (code: number | null, signal: string | null) => {
                outputChannel.appendLine(`[nifti-server] exited code=${String(code)} signal=${String(signal)}`);
                niftiServerProc = undefined;
                niftiServerPort = undefined;
                niftiServerStarting = undefined;
            });
            // safety timeout
            setTimeout(() => {
                if (typeof niftiServerPort !== 'number') {
                    try { proc.kill(); } catch {}
                    reject(new Error('NIfTI server startup timed out'));
                    niftiServerStarting = undefined;
                }
            }, 8000);
        } catch (e) {
            niftiServerStarting = undefined;
            reject(e);
        }
    });
    return niftiServerStarting;
}

function isRemoteEnvironment(): boolean {
    try {
        if (typeof vscode.env.remoteName === 'string' && vscode.env.remoteName.length > 0) {
            return true;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.some(folder => folder.uri.scheme !== 'file')) {
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

function postJsonToNiftiServer<T = any>(port: number, route: string, body: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        try {
            const http = require('http');
            const data = Buffer.from(JSON.stringify(body));
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                method: 'POST',
                path: route,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            }, (res: any) => {
                const chunks: Buffer[] = [];
                let totalSize = 0;
                const maxSize = 500 * 1024 * 1024; // 500MB limit to prevent memory issues
                
                res.on('data', (c: Buffer) => {
                    totalSize += c.length;
                    if (totalSize > maxSize) {
                        req.destroy();
                        reject(new Error(`Response too large: ${totalSize} bytes (max: ${maxSize})`));
                        return;
                    }
                    chunks.push(Buffer.from(c));
                });
                
                res.on('end', () => {
                    try {
                        // For very large responses, try to avoid string conversion issues
                        const totalBuffer = Buffer.concat(chunks);
                        outputChannel.appendLine(`[postJsonToNiftiServer] Response size: ${totalBuffer.length} bytes`);
                        
                        if (totalBuffer.length > 100 * 1024 * 1024) { // 100MB
                            outputChannel.appendLine(`[postJsonToNiftiServer] Warning: Large response detected, processing carefully...`);
                        }
                        
                        // Process in chunks if too large
                        let raw: string;
                        if (totalBuffer.length > 50 * 1024 * 1024) { // 50MB
                            // Process in smaller chunks to avoid string length limits
                            const chunkSize = 10 * 1024 * 1024; // 10MB chunks
                            let result = '';
                            for (let i = 0; i < totalBuffer.length; i += chunkSize) {
                                const chunk = totalBuffer.subarray(i, i + chunkSize);
                                result += chunk.toString('utf8');
                            }
                            raw = result;
                        } else {
                            raw = totalBuffer.toString('utf8');
                        }
                        
                        const json = JSON.parse(raw);
                        resolve(json as T);
                    } catch (err) {
                        outputChannel.appendLine(`[postJsonToNiftiServer] Parse error: ${err instanceof Error ? err.message : String(err)}`);
                        reject(err);
                    }
                });
            });
            req.on('error', (err: Error) => reject(err));
            req.write(data);
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

// Unified OBJ file handling function
async function handleOBJFilesFromServer(result: any, panel: vscode.WebviewPanel | undefined): Promise<void> {
    outputChannel.appendLine('[extension] *** handleOBJFilesFromServer CALLED ***');
    outputChannel.appendLine('[extension] Panel provided: ' + (!!panel));
    outputChannel.appendLine('[extension] Result provided: ' + (!!result));
    
    const files = (result && Array.isArray(result.generated_files)) ? result.generated_files : [];
    outputChannel.appendLine('[extension] Server result - total files: ' + files.length);
    
    const objFiles = files.filter((f: any) => f && f.format === 'obj');
    outputChannel.appendLine('[extension] Filtered OBJ files: ' + objFiles.length);
    
    // Debug each OBJ file
    objFiles.forEach((obj: any, idx: number) => {
        outputChannel.appendLine('[extension] OBJ ' + idx + ': label=' + obj.label + ', path=' + obj.path + ', color=' + JSON.stringify(obj.color));
    });
    
    if (objFiles.length === 0) {
        outputChannel.appendLine('[extension] No OBJ files found in server response');
        return;
    }
    
    outputChannel.appendLine('[extension] *** Processing ' + objFiles.length + ' OBJ files from filesystem ***');
    
    // Read all OBJ files from filesystem
    const readPromises = objFiles.map((objFile: any, idx: number) => {
        return new Promise((resolve) => {
            const filePath = objFile.path;
            if (!filePath || !fs.existsSync(filePath)) {
                outputChannel.appendLine('[extension] OBJ ' + idx + ': file not found: ' + filePath);
                resolve(null);
                return;
            }
            
            outputChannel.appendLine('[extension] Reading OBJ ' + idx + ': ' + filePath);
            fs.readFile(filePath, (err: any, data: any) => {
                if (err) {
                    outputChannel.appendLine('[extension] Error reading OBJ ' + idx + ': ' + err.message);
                    resolve(null);
                    return;
                }
                
                const base64 = data.toString('base64');
                resolve({
                    objBase64: base64,
                    label: objFile.label || ('label_' + idx),
                    color: objFile.color,
                    path: filePath
                });
            });
        });
    });
    
    try {
        const results = await Promise.all(readPromises);
        const validObjFiles = results.filter(r => r !== null);
        outputChannel.appendLine('[extension] Successfully read ' + validObjFiles.length + ' OBJ files');
        
        outputChannel.appendLine('[extension] *** About to decide message type - validObjFiles.length: ' + validObjFiles.length + ' ***');
        
        if (validObjFiles.length > 0) {         
            // Multiple OBJs - send multiObjContent
            outputChannel.appendLine('[extension] *** MULTI OBJ CASE - Sending multiObjContent for ' + validObjFiles.length + ' OBJs ***');
            outputChannel.appendLine('[extension] Panel webview exists: ' + (!!panel?.webview));
            
            if (panel?.webview) {
                // Check data size and implement batch sending to avoid message size limits
                const maxObjsPerBatch = 3; // Conservative limit to prevent postMessage failures
                const totalObjs = validObjFiles.length;
                
                outputChannel.appendLine('[extension] *** Processing ' + totalObjs + ' OBJs, max per batch: ' + maxObjsPerBatch + ' ***');
                
                // Calculate total data size estimate
                const sampleObj = validObjFiles[0];
                const estimatedSizePerObj = sampleObj?.objBase64?.length || 0;
                const totalEstimatedSize = estimatedSizePerObj * totalObjs;
                outputChannel.appendLine('[extension] Estimated total size: ' + Math.round(totalEstimatedSize / 1024 / 1024 * 100) / 100 + ' MB');
                
                if (totalObjs <= maxObjsPerBatch) {
                    // Send all in one message (small batch)
                    const base64List = validObjFiles.map(obj => obj.objBase64);
                    const objPathList = validObjFiles.map(obj => obj.path);
                    const colorList = validObjFiles.map(obj => obj.color);
                    
                    panel.webview.postMessage({ 
                        type: 'objContent', 
                        base64: base64List, 
                        objPath: objPathList, 
                        color: colorList,
                        batchInfo: { current: 1, total: 1, isComplete: true }
                    });
                    outputChannel.appendLine('[extension] *** Single batch objContent SENT successfully ***');
                } else {
                    // Send in multiple batches to avoid size limits
                    outputChannel.appendLine('[extension] *** Using batch mode for ' + totalObjs + ' OBJs ***');
                    
                    for (let batchIndex = 0; batchIndex < totalObjs; batchIndex += maxObjsPerBatch) {
                        const batchFiles = validObjFiles.slice(batchIndex, batchIndex + maxObjsPerBatch);
                        const currentBatch = Math.floor(batchIndex / maxObjsPerBatch) + 1;
                        const totalBatches = Math.ceil(totalObjs / maxObjsPerBatch);
                        const isLastBatch = batchIndex + maxObjsPerBatch >= totalObjs;
                        
                        const base64List = batchFiles.map(obj => obj.objBase64);
                        const objPathList = batchFiles.map(obj => obj.path);
                        const colorList = batchFiles.map(obj => obj.color);
                        
                        outputChannel.appendLine('[extension] Sending batch ' + currentBatch + '/' + totalBatches + ' (' + batchFiles.length + ' OBJs)');
                        
                        panel.webview.postMessage({ 
                            type: 'objContent', 
                            base64: base64List, 
                            objPath: objPathList, 
                            color: colorList,
                            batchInfo: { 
                                current: currentBatch, 
                                total: totalBatches, 
                                isComplete: isLastBatch,
                                batchSize: batchFiles.length
                            }
                        });
                        
                        outputChannel.appendLine('[extension] *** Batch ' + currentBatch + '/' + totalBatches + ' SENT successfully ***');
                        
                        // Add small delay between batches to prevent overwhelming
                        if (!isLastBatch) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }
                }
                
                outputChannel.appendLine('[extension] All OBJ batches sent, total objects: ' + totalObjs);
            } else {
                outputChannel.appendLine('[extension] *** ERROR: Cannot send objContent - panel or webview is null ***');
            }
        } else {
            outputChannel.appendLine('[extension] *** NO VALID OBJ FILES - nothing to display ***');
        }
    } catch (err) {
        outputChannel.appendLine('[extension] Error processing OBJ files: ' + (err instanceof Error ? err.message : String(err)));
    }
}

function getPreferredPythonPath(): string {
    const dicomConfig = vscode.workspace.getConfiguration('dicomViewer');
    const dicomPythonPath = dicomConfig.get<string>('pythonPath');
    if (dicomPythonPath) {
        return dicomPythonPath;
    }

    const pythonConfig = vscode.workspace.getConfiguration('python');
    const interpreterPath = pythonConfig.get<string>('defaultInterpreterPath') || pythonConfig.get<string>('pythonPath');
    if (interpreterPath) {
        return interpreterPath;
    }

    return 'python3';
}

// Mirror all host-side console logs into the Output channel while preserving original behavior
const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);
function toLogString(value: unknown): string {
    try {
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
function appendChannel(level: 'log' | 'warn' | 'error', args: unknown[]) {
    try {
        outputChannel.appendLine(`[host ${level}] ${args.map(toLogString).join(' ')}`);
    } catch {}
}
console.log = (...args: unknown[]) => { appendChannel('log', args); originalConsoleLog(...args); };
console.warn = (...args: unknown[]) => { appendChannel('warn', args); originalConsoleWarn(...args); };
console.error = (...args: unknown[]) => { appendChannel('error', args); originalConsoleError(...args); };

export function activate(context: vscode.ExtensionContext) {
    // 使用输出通道而不是console.log
    outputChannel.appendLine('DICOM Viewer with MPR (JDH Algo) is now active!');
    console.log('DICOM Viewer with MPR (JDH Algo) is now active!');
    extensionBasePath = context.extensionPath;
    ensurePythonEnvironment().catch(err => {
        const text = `Python environment missing dependencies: ${err instanceof Error ? err.message : String(err)}`;
        outputChannel.appendLine(text);
        vscode.window.showErrorMessage(text);
    });

    // 注册打开DICOM查看器的命令（不弹出对话框，直接打开查看器）
    const openDicomViewerCommand = vscode.commands.registerCommand(
        'dicom-viewer.openDicomViewer',
        async (uri?: vscode.Uri | readonly vscode.Uri[]) => {
            const targetUris = normalizeCommandUris(uri);
            await showDicomViewer(context, targetUris);
        }
    );

    context.subscriptions.push(openDicomViewerCommand);
}

type ViewerInitialLoadMessage =
    | { type: 'loadFiles'; files: string[] }
    | { type: 'loadDicomfolder'; files: string[] }
    | { type: 'loadNiiFiles'; files: string[] }
    | { type: 'loadSegFiles'; files: string[] };

async function prepareInitialLoadMessage(uris: readonly vscode.Uri[]): Promise<ViewerInitialLoadMessage | undefined> {
    if (!uris.length) {
        return undefined;
    }

    const firstUri = uris[0];
    try {
        const fileStat = await vscode.workspace.fs.stat(firstUri);
        if ((fileStat.type & vscode.FileType.Directory) !== 0) {
            return { type: 'loadDicomfolder', files: [firstUri.fsPath] };
        }
    } catch (statErr) {
        outputChannel.appendLine(
            `[extension] stat failed for ${firstUri.fsPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`
        );
    }

    const filePaths = uris.map(uri => uri.fsPath);
    const segmentationFiles = filePaths.filter(isSegmentationPath);
    if (segmentationFiles.length > 0 && segmentationFiles.length === filePaths.length) {
        return { type: 'loadSegFiles', files: segmentationFiles };
    }

    const niiFiles = filePaths.filter(isNiftiPath);
    if (niiFiles.length > 0) {
        return { type: 'loadNiiFiles', files: niiFiles };
    }

    return { type: 'loadFiles', files: filePaths };
}

// 显示DICOM查看器
async function showDicomViewer(context: vscode.ExtensionContext, uris: readonly vscode.Uri[]) {
    const initialLoadMessage = await prepareInitialLoadMessage(uris);
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        if (initialLoadMessage) {
            panel.webview.postMessage(initialLoadMessage);
        }
        return;
    }

    // 创建新的Webview面板
    panel = vscode.window.createWebviewPanel(
        'dicomViewer',
        'DICOM Viewer · JDH Algo',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'out'),
                vscode.Uri.joinPath(context.extensionUri, 'node_modules')
            ]
        }
    );

    // 设置Webview的HTML内容
    panel.webview.html = getWebviewContent(context, panel.webview);

    // 处理面板关闭事件
    panel.onDidDispose(() => {
        panel = undefined;
    });

    // 接收来自Webview的消息
    panel.webview.onDidReceiveMessage(
        (message: any) => {  // 这里已经有了正确的类型定义
            // 仅记录消息类型，避免输出结果型大数据
            try { outputChannel.appendLine(`接收到Webview消息: ${String((message && message.type) || 'unknown')}`); } catch {}
            
            switch (message.type) {
                case 'showMessage':
                    // 添加输出通道日志
                    outputChannel.appendLine(`显示信息: ${message.text}`);
                    console.log('显示信息:', message.text);
                    vscode.window.showInformationMessage(message.text);
                    break;
                case 'showError':
                    console.log('显示错误:', message.text);
                    vscode.window.showErrorMessage(message.text);
                    break;
                case 'requestFileContent':
                    console.log('请求文件内容:', message.filePath);
                    // 处理Webview请求文件内容的消息
                    if (panel) {
                        handleFileContentRequest(
                            message.filePath,
                            panel.webview,
                            message.callbackId,
                            message.sliceIndex,
                            message.plane,
                            message.windowCenter,
                            message.windowWidth,
                            message.isSeg,
                            message.segIndex
                        );
                    }
                    break;
                case 'log':
                    // Forward webview logs to the Output channel
                    try {
                        const level = (message.level || 'log').toString();
                        const text = (message.text || '').toString();
                        outputChannel.appendLine(`[webview ${level}] ${text}`);
                    } catch (e) {
                        outputChannel.appendLine(`[webview log] <failed to stringify>`);
                    }
                    break;
                
                case 'debug':
                    // Forward webview debug messages to the Output channel
                    try {
                        const text = (message.text || '').toString();
                        outputChannel.appendLine(`[webview] ${text}`);
                    } catch (e) {
                        outputChannel.appendLine(`[webview debug] <failed to stringify>`);
                    }
                    break;
                case 'requestLoadSeg':
                    console.log('请求加载分割');
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: true,
                        filters: {
                            'Segmentation Files': ['nii', 'nii.gz'],
                            'All Files': ['*']
                        }
                    }).then(fileUris => {
                        if (fileUris && fileUris.length > 0) {
                            const filePaths = fileUris.map(uri => uri.fsPath);
                            if (panel) {
                                panel.webview.postMessage({ type: 'loadSegFiles', files: filePaths });
                            }
                        }
                    });
                    break;
                // 在switch语句中添加requestLoadNiiFiles的处理
                case 'requestLoadNiiFiles':
                    console.log('请求加载NIfTI文件');
                    // 处理加载NIfTI文件的请求
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: true,
                        filters: {
                            'NIfTI Files': ['nii', 'nii.gz'],
                            'All Files': ['*']
                        }
                    }).then(fileUris => {
                        console.log('文件选择结果:', fileUris);
                        if (fileUris && fileUris.length > 0) {
                            const filePaths = fileUris.map(uri => uri.fsPath);
                            console.log('选择的文件路径:', filePaths);
                            if (panel) {
                                panel.webview.postMessage({ type: 'loadNiiFiles', files: filePaths });
                            }
                        }
                    });
                    break;
                case 'requestLoadNiiFolder':
                    console.log('请求加载NIfTI文件夹');
                    vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false
                    }).then(folderUri => {
                        if (folderUri && folderUri[0]) {
                            const folderPath = folderUri[0].fsPath;
                            if (panel) {
                                // 直接把文件夹传回前端，由前端逐个请求（延续现有 NIfTI 加载路径）
                                panel.webview.postMessage({ type: 'loadNiiFiles', files: [folderPath] });
                            }
                        }
                    });
                    break;
                case 'requestLoadFiles':
                    console.log('请求加载文件');
                    // 处理加载DICOM文件的请求
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: true,
                        filters: {
                            'DICOM Files': ['dcm'],
                            'All Files': ['*']
                        }
                    }).then(fileUris => {
                        console.log('文件选择结果:', fileUris);
                        if (fileUris && fileUris.length > 0) {
                            const filePaths = fileUris.map(uri => uri.fsPath);
                            console.log('选择的文件路径:', filePaths);
                            if (panel) {
                                panel.webview.postMessage({ type: 'loadFiles', files: filePaths });
                            }
                        }
                    });
                    break;
                
                case 'requestLoadFolder':
                    // 处理加载DICOM文件夹的请求
                    vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false
                    }).then(folderUri => {
                        if (folderUri && folderUri[0]) {
                            const folderPath = folderUri[0].fsPath;
                            // 仅读取该文件夹内的DICOM文件（不递归）
                            const fs = require('fs');
                            const path = require('path');
                            const list = fs.readdirSync(folderPath);
                            const filePaths = list
                                .map((name: string) => path.join(folderPath, name))
                            if (panel) {
                                // 直接将所选目录传给前端，由NiftiReader读取该目录作为DICOM序列
                                panel.webview.postMessage({ type: 'loadDicomfolder', files: [folderPath] });
                            } else {
                                console.log('No DICOM files found in the selected folder.', folderPath);
                                vscode.window.showWarningMessage('No DICOM files found in the selected folder.');
                            }
                        }
                    });
                    break;
                case 'requestRenderSegToVTP':
                    try {
                        const segPath = (message && message.segPath) ? String(message.segPath) : '';
                        if (!segPath) {
                            panel?.webview.postMessage({ type: 'renderError', error: 'No segPath provided' });
                            break;
                        }
                        // Try server endpoint first
                        (async () => {
                            try {
                                const port = await ensureNiftiServer();
                                const result = await postJsonToNiftiServer<any>(port, '/seg-to-obj', { segPath, includeContent: false });
                                if (result && result.success) {
                                    panel?.webview.postMessage({ type: 'renderResult', result });
                                    // Unified OBJ handling - always read from filesystem
                                    outputChannel.appendLine('[extension] *** About to call handleOBJFilesFromServer (server success path) ***');
                                    try {
                                        await handleOBJFilesFromServer(result, panel);
                                        outputChannel.appendLine('[extension] *** handleOBJFilesFromServer completed successfully ***');
                                    } catch (err) {
                                        outputChannel.appendLine('[extension] Error handling OBJ files: ' + (err instanceof Error ? err.message : String(err)));
                                        outputChannel.appendLine('[extension] Error stack: ' + (err instanceof Error ? err.stack : 'No stack'));
                                    }
                                } else {
                                    throw new Error((result && result.error) || 'Server returned error');
                                }
                            } catch (serverErr) {
                                // Fallback to python script
                                outputChannel.appendLine('[extension] Fallback to python script');
                                outputChannel.appendLine('[extension] Server error details: ' + (serverErr instanceof Error ? serverErr.message : JSON.stringify(serverErr)));
                                outputChannel.appendLine('[extension] Server error stack: ' + (serverErr instanceof Error ? serverErr.stack : 'No stack trace'));
                                outputChannel.appendLine('[extension] segPath: ' + segPath);
                                const { exec } = require('child_process');
                                const nodePath = require('path');
                                const basePath = extensionBasePath ?? __dirname;
                                const scriptPath = nodePath.join(basePath, 'src', 'seg_to_vtp.py');
                                outputChannel.appendLine(`[render] Using script=${scriptPath}`);
                                const cmd = `python3 "${scriptPath}" "${segPath}"`;
                                console.log(`[render] exec: ${cmd}`);
                                outputChannel.appendLine(`[render] exec: ${cmd}`);
                                exec(cmd, async (error: Error | null, stdout: string, stderr: string) => {
                                    if (error) {
                                        outputChannel.appendLine(`[render] exec error`);
                                        panel?.webview.postMessage({ type: 'renderError', error: `Failed to execute: ${error.message}` });
                                        return;
                                    }
                                    if (stderr) {
                                        outputChannel.appendLine(`[render] stderr: ${stderr.substring(0, 512)}${stderr.length > 512 ? '…' : ''}`);
                                    }
                                    try {
                                        const result = JSON.parse(stdout);
                                        outputChannel.appendLine(`[render] ok: files=${Array.isArray(result?.generated_files) ? result.generated_files.length : 0}`);
                                        panel?.webview.postMessage({ type: 'renderResult', result });
                                        // Unified OBJ handling - fallback to same function
                                        outputChannel.appendLine('[extension] *** About to call handleOBJFilesFromServer (python fallback path) ***');
                                        try {
                                            await handleOBJFilesFromServer(result, panel);
                                            outputChannel.appendLine('[extension] *** handleOBJFilesFromServer (fallback) completed successfully ***');
                                        } catch (err) {
                                            outputChannel.appendLine('[extension] Fallback: Error handling OBJ files: ' + (err instanceof Error ? err.message : String(err)));
                                            outputChannel.appendLine('[extension] Fallback: Error stack: ' + (err instanceof Error ? err.stack : 'No stack'));
                                        }
                                    } catch (e) {
                                        outputChannel.appendLine(`[render] parse error`);
                                        panel?.webview.postMessage({ type: 'renderError', error: `Parse error: ${e instanceof Error ? e.message : String(e)}` });
                                    }
                                });
                            }
                        })();
                    } catch (e) {
                        panel?.webview.postMessage({ type: 'renderError', error: e instanceof Error ? e.message : String(e) });
                    }
                    break;
            }
        },
        undefined,
        context.subscriptions  // 这里在正确的作用域中使用context
    );

    if (initialLoadMessage) {
        panel.webview.postMessage(initialLoadMessage);
    }
}

// 处理文件内容请求
async function handleFileContentRequest(filePath: string, webview: vscode.Webview, callbackId?: string, sliceIndex?: number, plane?: string, windowCenter?: number, windowWidth?: number, isSeg?: boolean, segIndex?: number) {
    try {
        const { exec } = require('child_process');
        const nodePath = require('path');
        const isDir = (() => { try { return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory(); } catch { return false; } })();
        const isNiftiFile = isDir || filePath.toLowerCase().endsWith('.nii') || filePath.toLowerCase().endsWith('.nii.gz');
        outputChannel.appendLine(`[requestFileContent] filePath=${filePath}, isNifti=${isNiftiFile}, callbackId=${callbackId ?? 'none'}`);

        if (isNiftiFile) {
            // Prefer persistent server to avoid re-reading volume each request
            try {
                const port = await ensureNiftiServer();
                const result = await postJsonToNiftiServer<any>(port, '/nifti', {
                    filePath,
                    sliceIndex,
                    plane,
                    windowCenter,
                    windowWidth,
                    isSeg
                });
                if (result && result.success) {
                    webview.postMessage({
                        type: 'fileContent',
                        filePath: filePath,
                        content: result.pixelData,
                        metadata: result.metadata,
                        rows: result.rows,
                        columns: result.columns,
                        fileType: 'nifti',
                        sliceIndex: result.sliceIndex,
                        axial: result.axial,
                        sagittal: result.sagittal,
                        coronal: result.coronal,
                        slices: result.slices,
                        plane: result.plane,
                        isSeg: !!isSeg,
                        segIndex: typeof segIndex === 'number' ? segIndex : undefined,
                        callbackId
                    });
                } else {
                    const errMsg = (result && result.error) ? String(result.error) : 'Unknown error from server';
                    outputChannel.appendLine(`[nifti-server] error: ${errMsg}`);
                    webview.postMessage({
                        type: 'fileContentError',
                        filePath: filePath,
                        error: errMsg,
                        callbackId
                    });
                }
                return;
            } catch (serverErr) {
                outputChannel.appendLine(`[nifti-server] failed, falling back to script. Reason: ${serverErr instanceof Error ? serverErr.message : String(serverErr)}`);
            }

            // Fallback: original one-shot script execution
            const basePath = extensionBasePath ?? __dirname;
            const scriptPath = nodePath.join(basePath, 'src', 'nifti_reader.py');
            outputChannel.appendLine(`[nifti] Using script=${scriptPath}`);
            return new Promise<void>((resolve, reject) => {
                const sliceArg = typeof sliceIndex === 'number' && !Number.isNaN(sliceIndex) ? ` ${sliceIndex}` : '';
                const planeArg = plane ? ` ${plane}` : '';
                const wcArg = (typeof windowCenter === 'number' && !Number.isNaN(windowCenter) && planeArg) ? ` ${windowCenter}` : '';
                const wwArg = (typeof windowWidth === 'number' && !Number.isNaN(windowWidth) && planeArg) ? ` ${windowWidth}` : '';
                const segArg = isSeg ? ' seg' : '';
                const cmd = `python3 "${scriptPath}" "${filePath}"${sliceArg}${planeArg}${wcArg}${wwArg}${segArg}`;
                outputChannel.appendLine(`[nifti] exec: ${cmd}`);
                exec(cmd, (error: Error | null, stdout: string, stderr: string) => {
                    if (error) {
                        outputChannel.appendLine(`[nifti] exec error: ${error.message}`);
                        webview.postMessage({ type: 'fileContentError', filePath, error: `Failed to execute Python script: ${error.message}`, callbackId });
                        reject(error);
                        return;
                    }
                    if (stderr) {
                        outputChannel.appendLine(`[nifti] stderr: ${stderr.substring(0, 512)}${stderr.length > 512 ? '…' : ''}`);
                        webview.postMessage({ type: 'fileContentError', filePath, error: `Python script error: ${stderr}`, callbackId });
                        reject(new Error(stderr));
                        return;
                    }
                    try {
                        const result = JSON.parse(stdout);
                        if (result.success) {
                            webview.postMessage({
                                type: 'fileContent', filePath, content: result.pixelData, metadata: result.metadata,
                                rows: result.rows, columns: result.columns, fileType: 'nifti', sliceIndex: result.sliceIndex,
                                axial: result.axial, sagittal: result.sagittal, coronal: result.coronal, slices: result.slices,
                                plane: result.plane, isSeg: !!isSeg, segIndex: typeof segIndex === 'number' ? segIndex : undefined, callbackId
                            });
                        } else {
                            outputChannel.appendLine(`[nifti] script returned error: ${result.error}`);
                            webview.postMessage({ type: 'fileContentError', filePath, error: result.error || 'Unknown error from Python script', callbackId });
                        }
                        resolve();
                    } catch (parseError) {
                        outputChannel.appendLine(`[nifti] parse error`);
                        webview.postMessage({ type: 'fileContentError', filePath, error: `Failed to parse Python script output: ${parseError instanceof Error ? parseError.message : String(parseError)}`, callbackId });
                        reject(parseError);
                    }
                });
            });
        } else {
            // DICOM: 读取原始文件字节，优先使用VS Code文件系统以兼容远程环境
            try {
                const remoteEnv = isRemoteEnvironment();
                const fileUri = vscode.Uri.file(filePath);
                const dataBytes = await vscode.workspace.fs.readFile(fileUri);
                const uint8View = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
                const arrayBuffer = uint8View.buffer.slice(uint8View.byteOffset, uint8View.byteOffset + uint8View.byteLength);

                const payload: Record<string, unknown> = {
                    type: 'fileContent',
                    filePath,
                    fileType: 'dicom',
                    contentBinary: arrayBuffer,
                    content: Buffer.from(uint8View).toString('base64'),
                    byteLength: uint8View.byteLength,
                    callbackId
                };

                if (remoteEnv) {
                    outputChannel.appendLine(`[dicom] remote environment detected, sending binary payload (${uint8View.byteLength} bytes) plus Base64 backup`);
                }

                webview.postMessage(payload);
            } catch (err: any) {
                const message = err instanceof Error ? err.message : String(err);
                outputChannel.appendLine(`[dicom] read error: ${message}`);
                webview.postMessage({
                    type: 'fileContentError',
                    filePath,
                    error: `Failed to read file: ${message}`,
                    callbackId
                });
                throw err;
            }
        }
    } catch (error) {
        // ... existing code ...
    }
}

// 获取Webview的HTML内容
function getWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview) {
    // 获取依赖库的URI
    const cornerstoneCoreUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'cornerstone-core', 'dist', 'cornerstone.js'));
    const cornerstoneMathUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'cornerstone-math', 'dist', 'cornerstoneMath.js'));
    const cornerstoneToolsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'cornerstone-tools', 'dist', 'cornerstoneTools.js'));
    const dicomParserUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'dicom-parser', 'dist', 'dicomParser.js'));
    const cornerstoneWadoImageLoaderUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'cornerstone-wado-image-loader', 'dist', 'cornerstoneWADOImageLoader.js'));
    const vtkJsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'vtk.js', 'vtk.js'));
    
    // 生成nonce以允许内联脚本
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DICOM Viewer</title>
    <style>
        :root {
            --primary-color: #0e639c;
            --primary-hover: #1177bb;
            --secondary-color: #2d2d30;
            --bg-color: #1e1e1e;
            --text-color: #d4d4d4;
            --border-color: #3e3e42;
            --success-color: #4ec9b0;
            --warning-color: #ce9178;
            --error-color: #f48771;
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            background-color: var(--secondary-color);
            border-bottom: 1px solid var(--border-color);
        }
        
        .header h1 {
            font-size: 16px;
            font-weight: 600;
            margin: 0;
        }
        
        .content { flex: 1; display: flex; min-height: 0; }
        .toolbar { display: flex; flex-direction: column; gap: 8px; background: var(--secondary-color); border-right: 1px solid var(--border-color); padding: 8px; width: 160px; min-width: 150px; }
        .main-views { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .toolbar { overflow-y: auto; }
        
        .tool-group {
            display: flex;
            gap: 6px;
            background-color: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            padding: 4px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.2) inset;
        }
        
        .toolbar button {
            background-color: rgba(255, 255, 255, 0.02);
            color: var(--text-color);
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 4px 8px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.15s ease;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .toolbar button:hover {
            background-color: rgba(255, 255, 255, 0.08);
            border-color: rgba(255, 255, 255, 0.18);
            transform: translateY(-1px);
        }
        
        .toolbar button.active {
            background-color: var(--primary-color);
            color: white;
            border-color: var(--primary-color);
            box-shadow: 0 0 0 3px rgba(14, 99, 156, 0.25);
        }
        
        .toolbar .file-operations { margin-left: 0; }
        .wl-inputs { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
        .wl-inputs input { width: 72px; padding: 4px 6px; background: #111; color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px; }
        
        .viewer-container { flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 8px; overflow: hidden; min-height: 0; }
        
        .view-container {
            position: relative;
            background-color: #000;
            border-radius: 0px;
            border: 0px solid transparent;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        
        .view-header {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            background-color: rgba(0, 0, 0, 0.55);
            padding: 2px 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 10;
        }
        
        .view-label {
            font-size: 11px;
            font-weight: 500;
            color: white;
        }
        
        .view-info {
            font-size: 10px;
            color: #aaa;
        }
        
        .dicom-view {
            flex: 1;
            width: 100%;
            height: 100%;
            position: relative;
        }

        .view-container canvas {
            width: 100%;
            height: 100%;
            image-rendering: pixelated;
            object-fit: contain; /* preserve original aspect ratio within panel */
        }

        .divider { display: none; }
        
        .status-bar {
            background-color: var(--secondary-color);
            padding: 4px 10px;
            border-top: 1px solid var(--border-color);
            font-size: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .status-info {
            color: var(--text-color);
        }
        
        .help-text { display: none; }

        .slice-controls { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
        .slice-controls input[type="range"] { width: 100%; }
        .slice-group { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }

        /* Sidebar collapse */
        .toolbar-toggle { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: var(--text-color); border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
        .toolbar-toggle:hover { background: rgba(255,255,255,0.16); }
        .sidebar-collapsed .toolbar { width: 0; min-width: 0; padding: 0; border-right: 0; overflow: hidden; }
        .sidebar-collapsed .toolbar .tool-group { display: none; }
        
        /* Tooltip styles */
        .tooltip {
            position: relative;
            display: inline-block;
        }
        
        .tooltip .tooltip-text {
            visibility: hidden;
            width: 120px;
            background-color: #333;
            color: #fff;
            text-align: center;
            border-radius: 4px;
            padding: 5px;
            position: absolute;
            z-index: 100;
            bottom: 125%;
            left: 50%;
            margin-left: -60px;
            opacity: 0;
            transition: opacity 0.3s;
            font-size: 11px;
        }
        
        .tooltip:hover .tooltip-text {
            visibility: visible;
            opacity: 1;
        }
        
        /* Responsive design */
        @media (max-width: 768px) {
            .viewer-container {
                grid-template-columns: 1fr;
                grid-template-rows: repeat(4, 1fr);
            }
            
            .toolbar {
                flex-direction: column;
                align-items: stretch;
            }
            
            .tool-group {
                justify-content: center;
            }
        }
        
        /* Animation for UI elements */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .view-container {
            animation: fadeIn 0.3s ease-out;
        }
        
        /* Scrollbar styles */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        
        ::-webkit-scrollbar-track {
            background: var(--secondary-color);
        }
        
        ::-webkit-scrollbar-thumb {
            background: #555;
            border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: #777;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>DICOM Viewer <span style="font-size: 14px; color: #888;">v0.0.6 · JDH Algo</span></h1>
        <div style="display:flex; align-items:center; gap: 8px;">
            <div id="series-info" class="view-info">No series loaded</div>
            <button id="toggleSidebarBtn" class="toolbar-toggle" title="Toggle sidebar">☰</button>
        </div>
    </div>
    
    <div class="content">
        <aside class="toolbar">
            <div class="tool-group" style="flex-direction: column; align-items: stretch; gap: 10px;">
                <label>WC <input id="wl-center" type="number" value="40" step="1" /></label>
                <label>WW <input id="wl-width" type="number" value="400" step="1" /></label>
                <span class="tooltip-text">Set Window/Level</span>
                <button id="loadNiiBtn" class="tooltip">
                    <span>📁</span> Load NIfTI
                    <span class="tooltip-text">Load NIfTI Files (Ctrl+O)</span>
                </button>
                <button id="loadDicomFolderBtn" class="tooltip">
                    <span>📂</span> Load DICOM Folder
                    <span class="tooltip-text">Load DICOM Folder</span>
                </button>
                <button id="loadSegBtn" class="tooltip">
                    <span>🩺</span> Load Seg
                    <span class="tooltip-text">Load Segmentation (NIfTI)</span>
                </button>
            <button id="renderSegBtn" class="tooltip" disabled>
                    <span>🧩</span> Render
                    <span class="tooltip-text">Generate OBJ from Seg</span>
                </button>
            
                <div class="slice-group">
                    <strong>Seg Opacity</strong>
                    <span id="seg-opacity-label">40%</span>
                    <input id="seg-opacity-range" type="range" min="0" max="100" value="40" />
                </div>
                <div class="slice-controls">
                    <div class="slice-group">
                        <strong>Axial</strong>
                        <span id="axial-slice-label">-/-</span>
                        <input id="axial-slice-range" type="range" min="1" max="1" value="1" />
                    </div>
                    <div class="slice-group">
                        <strong>Sagittal</strong>
                        <span id="sagittal-slice-label">-/-</span>
                        <input id="sagittal-slice-range" type="range" min="1" max="1" value="1" />
                    </div>
                    <div class="slice-group">
                        <strong>Coronal</strong>
                        <span id="coronal-slice-label">-/-</span>
                        <input id="coronal-slice-range" type="range" min="1" max="1" value="1" />
                    </div>
                </div>
            </div>
        </aside>
        <main class="main-views">
            <div class="viewer-container">
                <div class="view-container">
                    <div class="view-header">
                        <span class="view-label">Axial View</span>
                        <span class="view-info" id="axial-info">—</span>
                    </div>
                    <div id="axialView" class="dicom-view"></div>
                </div>
                <div class="view-container">
                    <div class="view-header">
                        <span class="view-label">Sagittal View</span>
                        <span class="view-info" id="sagittal-info">—</span>
                    </div>
                    <div id="sagittalView" class="dicom-view"></div>
                </div>
                <div class="view-container">
                    <div class="view-header">
                        <span class="view-label">3D View</span>
                        <span class="view-info" id="volume-info">—</span>
                    </div>
                    <div id="volumeView" class="dicom-view"></div>
                </div>
                <div class="view-container">
                    <div class="view-header">
                        <span class="view-label">Coronal View</span>
                        <span class="view-info" id="coronal-info">—</span>
                    </div>
                    <div id="coronalView" class="dicom-view"></div>
                </div>
            </div>
            <div class="status-bar">
                <div id="status-info" class="status-info">Ready</div>
                <div class="help-text">Hover over tools for shortcuts</div>
            </div>
        </main>
    </div>

    <script nonce="${nonce}" src="${cornerstoneCoreUri}"></script>
    <script nonce="${nonce}" src="${cornerstoneMathUri}"></script>
    <script nonce="${nonce}" src="${dicomParserUri}"></script>
    <script nonce="${nonce}" src="${cornerstoneWadoImageLoaderUri}"></script>
    <script nonce="${nonce}" src="${cornerstoneToolsUri}"></script>
    <script nonce="${nonce}" src="${vtkJsUri}"></script>
    
    <script nonce="${nonce}">
        // Configure Cornerstone
        try {
            cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
            cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
        } catch (e) {
            console.warn('Cornerstone libraries not available yet:', e);
        }
        
        // ... 在vscode对象获取后添加以下代码
        const vscode = acquireVsCodeApi();
        console.log('VS Code API获取成功:', vscode);
        const VTK_JS_URL = "${vtkJsUri}";
        function ensureVtkLoaded() {
            try {
                if (typeof vtk !== 'undefined') {
                    console.log('[webview] VTK already loaded, checking OBJ reader:', !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader));
                    return Promise.resolve(true);
                }
            } catch (e) {}
            return new Promise(function(resolve) {
                let settled = false;
                function finish() {
                    if (settled) return;
                    settled = true;
                    const vtkLoaded = typeof vtk !== 'undefined';
                    console.log('[webview] VTK loading finished:', {
                        vtkLoaded: vtkLoaded,
                        vtkOBJReader: vtkLoaded && !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                        vtkIO: vtkLoaded && !!(vtk && vtk.IO),
                        vtkIOMisc: vtkLoaded && !!(vtk && vtk.IO && vtk.IO.Misc)
                    });
                    try { resolve(vtkLoaded); } catch (e) { resolve(false); }
                }
                try {
                    const s1 = document.createElement('script');
                    s1.src = VTK_JS_URL;
                    s1.onload = finish;
                    s1.onerror = finish;
                    document.head.appendChild(s1);
                } catch (e) { /* ignore */ }
                // Always resolve after a timeout to avoid hanging promises
                setTimeout(finish, 2000);
            });
        }
        // Mirror webview console logs to extension output channel while preserving original behavior
        (function() {
            try {
                const origLog = console.log.bind(console);
                const origWarn = console.warn.bind(console);
                const origError = console.error.bind(console);
                function toText(val) {
                    try { return typeof val === 'string' ? val : JSON.stringify(val); } catch (e) { return String(val); }
                }
                function forward(level, args) {
                    try { vscode.postMessage({ type: 'log', level: level, text: args.map(toText).join(' ') }); } catch (e) {}
                }
                console.log = function() { forward('log', Array.from(arguments)); origLog.apply(console, arguments); };
                console.warn = function() { forward('warn', Array.from(arguments)); origWarn.apply(console, arguments); };
                console.error = function() { forward('error', Array.from(arguments)); origError.apply(console, arguments); };
            } catch (e) {}
        })();
        
        // 添加缺失的DOM元素变量定义
        const axialElement = document.getElementById('axialView');
        const sagittalElement = document.getElementById('sagittalView');
        const coronalElement = document.getElementById('coronalView');
        const volumeElement = document.getElementById('volumeView');
        const seriesInfo = document.getElementById('series-info');
        const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
        if (toggleSidebarBtn) {
            toggleSidebarBtn.addEventListener('click', function() {
                try {
                    document.body.classList.toggle('sidebar-collapsed');
                    setTimeout(function(){ try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 10);
                    setTimeout(function(){ try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 120);
                    
                } catch (e) {}
            });
        }
        let currentSegFiles = [];
        let currentSegSlices = { axial: 1, sagittal: 1, coronal: 1 };
        let currentSegIndices = { axial: 0, sagittal: 0, coronal: 0 };
        let currentSegColors = [
            [255, 0, 0, 96],
            [0, 255, 0, 96],
            [0, 0, 255, 96],
            [255, 255, 0, 96],
            [255, 0, 255, 96],
            [0, 255, 255, 96],
            [255, 128, 0, 96],
            [128, 0, 255, 96]
        ];
        const axialSliceRange = document.getElementById('axial-slice-range');
        const sagittalSliceRange = document.getElementById('sagittal-slice-range');
        const coronalSliceRange = document.getElementById('coronal-slice-range');
        const axialSliceLabel = document.getElementById('axial-slice-label');
        const sagittalSliceLabel = document.getElementById('sagittal-slice-label');
        const coronalSliceLabel = document.getElementById('coronal-slice-label');
        let currentNiftiFile = null;
        let baseVolumeShape = null; // [x, y, z]
        let currentSlices = 1;
        let currentSliceIndex = 0; // kept for backward compatibility
        let axialSliceIndex = 0;
        let sagittalSliceIndex = 0;
        let coronalSliceIndex = 0;
        let loadedSeries = [];
        
        // Initialize Cornerstone elements
        try {
            console.log('Initializing Cornerstone elements...');
            cornerstone.enable(axialElement);
            cornerstone.enable(sagittalElement);
            cornerstone.enable(coronalElement);
            cornerstone.enable(volumeElement);
            console.log('Cornerstone elements enabled successfully');
            
            // Initialize Cornerstone Tools - v2 API
            console.log('Setting up Cornerstone Tools external dependencies...');
            cornerstoneTools.external.cornerstone = cornerstone;
            cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
            console.log('Cornerstone Tools external dependencies set');
            
            // Initialize tools (Cornerstone Tools v2 doesn't require init())
            console.log('Adding tools...');
            
            // Define helper function for button active state
            function setActiveButton(activeId) {
                ['panBtn', 'zoomBtn', 'adjustWindowBtn', 'rotateBtn', 'measureBtn'].forEach(function(id) {
                    const btn = document.getElementById(id);
                    if (btn) {
                        if (id === activeId) {
                            btn.classList.add('active');
                        } else {
                            btn.classList.remove('active');
                        }
                    }
                });
            }
            
            // Add tools to all elements
            var elements = [axialElement, sagittalElement, coronalElement, volumeElement];
            elements.forEach(function(element) {
                // Add Pan/Zoom tools (basic mouse interactions)
                cornerstoneTools.pan.activate(element, 1); // left mouse button
                cornerstoneTools.zoom.activate(element, 4); // middle mouse button
                cornerstoneTools.wwwc.activate(element, 2); // right mouse button
            });
            console.log('Basic tools activated for all elements');
            
            // Add tool button event listeners (guard if button exists)
            (function() {
                const panBtn = document.getElementById('panBtn');
                if (!panBtn) return;
                panBtn.addEventListener('click', function() {
                    console.log('Pan tool activated');
                    elements.forEach(function(element) {
                        cornerstoneTools.pan.activate(element, 1);
                        cornerstoneTools.zoom.deactivate(element, 1);
                        cornerstoneTools.wwwc.deactivate(element, 1);
                    });
                    setActiveButton('panBtn');
                });
            })();
            
            // zoom button removed
            
            // window/level button replaced by numeric inputs
            
            // rotate button removed
            
            // measure button removed
            
            // reset button removed
            
            // invert button removed
            
            console.log('All tools and buttons configured successfully');
            
        } catch (err) {
            console.error('Failed to initialize Cornerstone:', err, err.message, err.stack);
            updateStatus('Failed to initialize viewer: ' + (err.message || String(err)));
        }
        
        // 添加缺失的updateStatus函数定义
        function updateStatus(message) {
            console.log('Status updated:', message);
            const statusElement = document.getElementById('status-info');
            if (statusElement) {
                statusElement.textContent = message;
            }
        }
        
        // 添加缺失的updateViewInfo函数定义
        function updateViewInfo(elementId, message) {
            console.log('View info updated:', elementId, message);
            const infoElement = document.getElementById(elementId);
            if (infoElement) {
                infoElement.textContent = message;
            }
        }
        
        // 添加loadNiiBtn事件监听器
        const loadNiiBtn = document.getElementById('loadNiiBtn');
        if (loadNiiBtn) {
            loadNiiBtn.addEventListener('click', function() {
                console.log('点击了加载NIfTI文件按钮');
                vscode.postMessage({ type: 'requestLoadNiiFiles' });
            });
        }
        const loadDicomFolderBtn = document.getElementById('loadDicomFolderBtn');
        if (loadDicomFolderBtn) {
            loadDicomFolderBtn.addEventListener('click', function() {
                console.log('点击了加载DICOM文件夹按钮');
                vscode.postMessage({ type: 'requestLoadFolder' });
            });
        }
        const loadSegBtn = document.getElementById('loadSegBtn');
        if (loadSegBtn) {
            loadSegBtn.addEventListener('click', function() {
                console.log('点击了加载分割按钮');
                vscode.postMessage({ type: 'requestLoadSeg' });
            });
        }
        

        // Add context menu action to manually load a .vtp or .obj if needed
        
        const renderSegBtn = document.getElementById('renderSegBtn');
                        if (renderSegBtn) {
                            renderSegBtn.setAttribute('disabled', 'true');
                            renderSegBtn.addEventListener('click', function() {
                                try {
                                    if (!currentSegFiles || currentSegFiles.length === 0) return;
                                    renderSegBtn.setAttribute('disabled', 'true');
                                    updateStatus('Rendering segmentation to OBJ...');
                                    console.log('[webview] *** Render button clicked, requesting seg render ***');
                                    try { vscode.postMessage({ type: 'debug', text: '*** Render button clicked, requesting seg render for: ' + currentSegFiles[0] }); } catch (e) {}
                                    vscode.postMessage({ type: 'requestRenderSegToVTP', segPath: currentSegFiles[0] });
                                } catch (e) {}
                            });
                        }
        // Add W/L numeric inputs handlers
        (function() {
            try {
                const wcInput = document.getElementById('wl-center');
                const wwInput = document.getElementById('wl-width');
                function applyWL() {
                    try {
                        const wc = parseFloat(wcInput && wcInput.value);
                        const ww = parseFloat(wwInput && wwInput.value);
                        [axialElement, sagittalElement, coronalElement, volumeElement].forEach(function(el) {
                            try {
                                const viewport = cornerstone.getViewport(el);
                                if (Number.isFinite(wc)) viewport.voi.windowCenter = wc;
                                if (Number.isFinite(ww) && ww > 0) viewport.voi.windowWidth = ww;
                                cornerstone.setViewport(el, viewport);
                            } catch (e) {}
                        });
                    } catch (e) { console.error('applyWL error', e); }
                }
                function requestAllPlanesWithWL() {
                    try {
                        if (!currentNiftiFile) return;
                        const wc = parseFloat(wcInput && wcInput.value);
                        const ww = parseFloat(wwInput && wwInput.value);
                        function requestPlane(plane, index) {
                            const cbId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                            window[cbId] = function(response) {
                                delete window[cbId];
                                if (!response || response.error) return;
                                displayNiftiData(response);
                            };
                            vscode.postMessage({
                                type: 'requestFileContent',
                                filePath: currentNiftiFile,
                                callbackId: cbId,
                                sliceIndex: index,
                                plane: plane,
                                windowCenter: Number.isFinite(wc) ? wc : undefined,
                                windowWidth: Number.isFinite(ww) ? ww : undefined
                            });
                        }
                        requestPlane('axial', axialSliceIndex);
                        requestPlane('sagittal', sagittalSliceIndex);
                        requestPlane('coronal', coronalSliceIndex);
                        if (currentSegFiles && currentSegFiles.length > 0) {
                            requestSegAllPlanes();
                        }
                    } catch (e) {}
                }
                if (wcInput) wcInput.addEventListener('change', function() { applyWL(); requestAllPlanesWithWL(); });
                if (wwInput) wwInput.addEventListener('change', function() { applyWL(); requestAllPlanesWithWL(); });
                if (wcInput) wcInput.addEventListener('keyup', function(ev) { if (ev.key === 'Enter') { applyWL(); requestAllPlanesWithWL(); } });
                if (wwInput) wwInput.addEventListener('keyup', function(ev) { if (ev.key === 'Enter') { applyWL(); requestAllPlanesWithWL(); } });
            } catch (e) { console.warn('WL inputs init error', e); }
        })();
        
        // Override console.log to forward to extension output channel
        const originalConsoleLog = console.log;
        const originalConsoleError = console.error;
        const originalConsoleWarn = console.warn;
        
        console.log = function(...args) {
            originalConsoleLog.apply(console, args);
            try {
                const text = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
                vscode.postMessage({ type: 'debug', text: text });
            } catch (e) {}
        };
        
        console.error = function(...args) {
            originalConsoleError.apply(console, args);
            try {
                const text = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
                vscode.postMessage({ type: 'debug', text: 'ERROR: ' + text });
            } catch (e) {}
        };
        
        console.warn = function(...args) {
            originalConsoleWarn.apply(console, args);
            try {
                const text = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
                vscode.postMessage({ type: 'debug', text: 'WARN: ' + text });
            } catch (e) {}
        };

        // Receive messages from VSCode extension
        window.addEventListener('message', function(event) {
            const message = event.data;
            console.log('[webview] *** Message received:', message?.type, '***');
            // console.log('[webview] Full message:', message);
            
            // Extra debugging for message validation
            if (!message) {
                console.log('[webview] *** CRITICAL: message is null/undefined ***');
                return;
            }
            
            switch (message.type) {
                case 'loadFiles':
                    console.log('加载文件:', message.files);
                    loadDicomFiles(message.files);
                    break;
                case 'loadDicomfolder':
                    console.log('[webview] loadDicomfolder:', message.files);
                    loadDicomfolder(message.files);
                    break;
                case 'fileContent':
                    // Handle file content response
                    if (window[message.callbackId]) {
                        window[message.callbackId](message);
                    }
                    // If this is a segmentation payload, paint onto corresponding view immediately
                    if (message && message.isSeg) {
                        try {
                            const p = (message.plane || '').toLowerCase();
                            if (p === 'axial') {
                                displayNiftiData({ plane: 'axial', rows: message.rows, columns: message.columns, pixelData: message.content, isSeg: true, metadata: message.metadata });
                            } else if (p === 'sagittal') {
                                displayNiftiData({ plane: 'sagittal', rows: message.rows, columns: message.columns, pixelData: message.content, isSeg: true, metadata: message.metadata });
                            } else if (p === 'coronal') {
                                displayNiftiData({ plane: 'coronal', rows: message.rows, columns: message.columns, pixelData: message.content, isSeg: true, metadata: message.metadata });
                            }
                        } catch (e) {}
                    }
                    break;
                case 'fileContentError':
                    // Handle file content error
                    if (window[message.callbackId]) {
                        window[message.callbackId](message);
                    }
                    break;
                case 'loadNiiFiles':
                    console.log('[webview] loadNiiFiles:', message.files);
                    loadNiftiFiles(message.files);
                    break;
                case 'loadSegFiles':
                    console.log('[webview] loadSegFiles:', message.files);
                    currentSegFiles = Array.isArray(message.files) ? message.files : [];
                    updateStatus('Segmentation loaded: ' + currentSegFiles.length + ' file(s)');
                    // Optionally auto-load mid-slice overlays for first seg file
                    if (currentNiftiFile && currentSegFiles.length > 0) requestSegAllPlanes();
                    try {
                        const btn = document.getElementById('renderSegBtn');
                        if (btn) {
                            if (currentSegFiles.length > 0) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', 'true');
                        }
                    } catch (e) {}
                    break;
                
                case 'renderResult':
                    try {
                        const btn = document.getElementById('renderSegBtn');
                        if (btn) btn.removeAttribute('disabled');
                        if (message && message.result && message.result.success) {
                            updateStatus('Rendered VTP files: ' + (message.result.total_files || 0));
                            try { vscode.postMessage({ type: 'showMessage', text: 'Render success: ' + (message.result.total_files || 0) + ' files' }); } catch (e) {}
                        } else {
                            updateStatus('Render finished with error');
                            try { vscode.postMessage({ type: 'showError', text: (message && message.result && message.result.error) || 'Render failed' }); } catch (e) {}
                        }
                    } catch (e) {}
                    break;
                case 'renderError':
                    try {
                        const btn = document.getElementById('renderSegBtn');
                        if (btn) btn.removeAttribute('disabled');
                        updateStatus('Render error: ' + (message && message.error ? message.error : 'Unknown'));
                        try { vscode.postMessage({ type: 'showError', text: 'Render error: ' + (message && message.error ? message.error : 'Unknown') }); } catch (e) {}
                    } catch (e) {}
                    break;
                
                case 'objContent':
                    try {
                        console.log('[webview] objContent received, message');
                        if (!message || !message.base64) break;
                        
                        // Handle both single and array formats
                        const base64List = Array.isArray(message.base64) ? message.base64 : [message.base64];
                        const colorList = Array.isArray(message.color) ? message.color : [message.color];
                        const objPathList = Array.isArray(message.objPath) ? message.objPath : [message.objPath];
                        
                        console.log('[webview] objContent received, files count:', base64List.length);
                        
                        // Handle batch information
                        const batchInfo = message.batchInfo || { current: 1, total: 1, isComplete: true };
                        console.log('[webview] Batch info:', batchInfo.current + '/' + batchInfo.total, 'complete:', batchInfo.isComplete);
                        
                        // Accumulate batch data
                        if (!window.objBatchAccumulator) {
                            window.objBatchAccumulator = {
                                base64List: [],
                                colorList: [],
                                objPathList: [],
                                totalExpected: batchInfo.total
                            };
                        }
                        
                        // Add current batch data
                        window.objBatchAccumulator.base64List.push(...base64List);
                        window.objBatchAccumulator.colorList.push(...colorList);
                        window.objBatchAccumulator.objPathList.push(...objPathList);
                        
                        console.log('[webview] Accumulated so far:', window.objBatchAccumulator.base64List.length, 'objects');
                        
                        if (batchInfo.isComplete) {
                            // All batches received, process complete data
                            const allBase64 = window.objBatchAccumulator.base64List;
                            const allColors = window.objBatchAccumulator.colorList;
                            const allObjPaths = window.objBatchAccumulator.objPathList;
                            
                            console.log('[webview] All batches received, total objects:', allBase64.length);
                            
                            // Clear accumulator
                            window.objBatchAccumulator = null;
                            
                            if (allBase64.length === 1) {
                                // Single OBJ - use existing render logic
                                const base64 = String(allBase64[0]);
                                const bin = window.atob(base64);
                                const n = bin.length;
                                const bytes = new Uint8Array(n);
                                for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
                                console.log('[webview] Single objContent, bytes=', bytes.byteLength);
                                try { updateViewInfo('volume-info', 'Loading OBJ…========='); } catch (e) {}
                                ensureVtkLoaded().then(function() {
                                    console.log('inner update view obj');
                                    try { retryRenderOBJ(bytes.buffer, 8, allColors[0]); } catch (e) { console.log('error render obj', e); }
                                });
                                console.log('[webview] finish');
                                updateViewInfo('volume-info', 'Finish Load');
                            } else {
                                // Multiple OBJs - convert to multiObjContent format and use existing multi logic
                                console.log('[webview] Multiple objContent (' + allBase64.length + ' total), converting to multiObjContent format');
                                const objFiles = allBase64.map((base64, idx) => ({
                                    objBase64: base64,
                                    label: 'label_' + idx,
                                    color: allColors[idx] || undefined,
                                    path: allObjPaths[idx] || ''
                                }));
                                
                                try { updateViewInfo('volume-info', 'Loading Multi-Label OBJ (' + objFiles.length + ')…========='); } catch (e) {}
                                ensureVtkLoaded().then(function() {
                                    console.log('[webview] *** VTK loaded, calling retryRenderMultiOBJ for ' + objFiles.length + ' objects ***');
                                    try { 
                                        retryRenderMultiOBJ(objFiles, 8); 
                                    } catch (e) { 
                                        console.error('[webview] *** retryRenderMultiOBJ error ***', e); 
                                    }
                                }).catch(function(e) {
                                    console.error('[webview] *** ensureVtkLoaded failed ***', e);
                                });
                                console.log('[webview] *** multiObjContent processing complete ***');
                                updateViewInfo('volume-info', 'Finish Load Multi (' + objFiles.length + ')');
                            }
                        } else {
                            // Still waiting for more batches
                            try { 
                                updateViewInfo('volume-info', 'Loading batch ' + batchInfo.current + '/' + batchInfo.total + '…'); 
                            } catch (e) {}
                            console.log('[webview] Waiting for batch', (batchInfo.current + 1) + '/' + batchInfo.total);
                        }
                    } catch (e) { console.error('[webview] objContent error', e); }
                    break;
            }
        });
        
        // Load DICOM files
        async function loadDicomFiles(filePaths) {
            try {
                console.log('[webview] start load DICOM files:', filePaths);
                updateStatus('Loading ' + filePaths.length + ' DICOM files...');
                
                // Store all loaded images
                const loadedImages = [];
                
                // Create unique imageId for each file path
                const imageIds = filePaths.map(function(filePath, index) {
                    return 'vscode-dicom://' + index;
                });
                
                // Register custom image loader
                cornerstone.registerImageLoader('vscode-dicom', function(imageId) {
                    const index = parseInt(imageId.split('://')[1]);
                    const filePath = filePaths[index];
                    
                    console.log('[webview] Loading image', index, 'from', filePath);
                    
                    // 使用Promise包装整个加载过程
                    return new Promise(function(resolve, reject) {
                        // Request file content
                        requestFileContent(filePath)
                            .then(function(responsePayload) {
                                try {
                                    if (!responsePayload) {
                                        reject(new Error('Empty response payload'));
                                        return;
                                    }
                                    const arrayBuffer = responsePayload.contentBinary ?
                                        responsePayload.contentBinary :
                                        base64ToArrayBuffer(responsePayload.content || '');
                                    if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number') {
                                        reject(new Error('Invalid DICOM payload'));
                                        return;
                                    }
                                    console.log('[webview] Received DICOM content, bytes=', arrayBuffer.byteLength);
                                    
                                    // Parse DICOM file using dicom-parser
                                    const byteArray = new Uint8Array(arrayBuffer);
                                    const dataSet = dicomParser.parseDicom(byteArray);
                                    console.log('[webview] DICOM parsed successfully');
                                    
                                    // Extract pixel data and create image manually
                                    const pixelDataElement = dataSet.elements.x7fe00010;
                                    if (!pixelDataElement) {
                                        reject(new Error('No pixel data found in DICOM file'));
                                        return;
                                    }
                                    
                                    const rows = dataSet.uint16('x00280010');
                                    const columns = dataSet.uint16('x00280011');
                                    const bitsAllocated = dataSet.uint16('x00280100') || 16;
                                    const pixelRepresentation = dataSet.uint16('x00280103') || 0;
                                    const samplesPerPixel = dataSet.uint16('x00280002') || 1;
                                    const rescaleSlope = dataSet.floatString('x00281053') || 1;
                                    const rescaleIntercept = dataSet.floatString('x00281052') || 0;
                                    const windowCenter = dataSet.floatString('x00281050') || 40;
                                    const windowWidth = dataSet.floatString('x00281051') || 400;
                                    
                                    console.log('[webview] Image dimensions:', rows, 'x', columns, 'bits=', bitsAllocated);
                                    
                                    // Get pixel data
                                    let pixelData;
                                    if (bitsAllocated === 16) {
                                        if (pixelRepresentation === 0) {
                                            pixelData = new Uint16Array(arrayBuffer, pixelDataElement.dataOffset, pixelDataElement.length / 2);
                                        } else {
                                            pixelData = new Int16Array(arrayBuffer, pixelDataElement.dataOffset, pixelDataElement.length / 2);
                                        }
                                    } else {
                                        pixelData = new Uint8Array(arrayBuffer, pixelDataElement.dataOffset, pixelDataElement.length);
                                    }
                                    
                                    // Calculate min/max for proper windowing
                                    let minPixelValue = pixelData[0];
                                    let maxPixelValue = pixelData[0];
                                    for (let i = 1; i < pixelData.length; i++) {
                                        if (pixelData[i] < minPixelValue) minPixelValue = pixelData[i];
                                        if (pixelData[i] > maxPixelValue) maxPixelValue = pixelData[i];
                                    }
                                    
                                    // Create cornerstone image object
                                    const image = {
                                        imageId: imageId,
                                        minPixelValue: minPixelValue,
                                        maxPixelValue: maxPixelValue,
                                        slope: rescaleSlope,
                                        intercept: rescaleIntercept,
                                        windowCenter: windowCenter,
                                        windowWidth: windowWidth,
                                        render: cornerstone.renderGrayscaleImage,
                                        getPixelData: function() { return pixelData; },
                                        rows: rows,
                                        columns: columns,
                                        height: rows,
                                        width: columns,
                                        color: samplesPerPixel > 1,
                                        columnPixelSpacing: dataSet.floatString('x00280030') || 1.0,
                                        rowPixelSpacing: dataSet.floatString('x00280030') || 1.0,
                                        sizeInBytes: pixelData.byteLength,
                                        dataSet: dataSet
                                    };
                                    
                                    console.log('[webview] Image object created successfully');
                                    resolve(image);
                                } catch (error) {
                                    console.error('[webview] Error processing DICOM:', error);
                                    reject(new Error('Failed to process DICOM file: ' + (error ? error.message : 'Unknown error')));
                                }
                            })
                            .catch(function(error) {
                                console.error('[webview] requestFileContent error:', error);
                                reject(new Error('Failed to load file content: ' + (error ? error.message : 'Unknown error')));
                            });
                    });
                });
                
                console.log('[webview] Image loader registered, starting to load images...');
                
                // Load all images
                for (let i = 0; i < imageIds.length; i++) {
                    try {
                        updateStatus('Loading image ' + (i + 1) + ' of ' + imageIds.length);
                        console.log('[webview] Calling cornerstone.loadImage for', imageIds[i]);
                        const image = await cornerstone.loadImage(imageIds[i]);
                        console.log('[webview] Image loaded successfully:', image.width, 'x', image.height);
                        loadedImages.push(image);
                    } catch (error) {
                        console.error('[webview] Failed to load image', i, ':', error);
                        updateStatus('Failed to load image ' + (i + 1) + ': ' + (error.message || error));
                    }
                }
                
                console.log('[webview] Total images loaded:', loadedImages.length);
                
                if (loadedImages.length > 0) {
                    // Sort by instance number (assuming CT/MRI series)
                    loadedImages.sort(function(a, b) {
                        const instanceNumberA = (a.dataSet && a.dataSet.intString('x00200013')) || 0;
                        const instanceNumberB = (b.dataSet && b.dataSet.intString('x00200013')) || 0;
                        return instanceNumberA - instanceNumberB;
                    });
                    
                    console.log('[webview] Images sorted, displaying first image...');
                    
                    // Display first image
                    cornerstone.displayImage(axialElement, loadedImages[0]);
                    console.log('[webview] First image displayed');
                    
                    // Store loaded series
                    loadedSeries = loadedImages;
                    
                    // Update series information
                    const seriesDescription = (loadedImages[0].dataSet && loadedImages[0].dataSet.string('x0008103e')) || 'Unknown Series';
                    const studyDate = (loadedImages[0].dataSet && loadedImages[0].dataSet.string('x00080020')) || 'Unknown Date';
                    seriesInfo.textContent = seriesDescription + ' (' + loadedImages.length + ' images, ' + studyDate + ')';
                    
                    // Initialize MPR views
                    initializeMPR();
                    
                    updateStatus('Successfully loaded ' + loadedImages.length + ' DICOM images');
                    vscode.postMessage({ type: 'showMessage', text: 'Successfully loaded ' + loadedImages.length + ' DICOM images!' });
                } else {
                    updateStatus('No valid DICOM images were loaded');
                    vscode.postMessage({ type: 'showError', text: 'No valid DICOM images were loaded.' });
                }
            } catch (error) {
                console.error('[webview] Error in loadDicomFiles:', error);
                updateStatus('Failed to load DICOM files: ' + (error.message || error));
                vscode.postMessage({ type: 'showError', text: 'Failed to load DICOM files: ' + (error.message || error) });
            }
        }
        // Load DICOM folder using Python NiftiReader (directory treated as series)
        async function loadDicomfolder(folders) {
            try {
                if (!folders || folders.length === 0) return;
                const folderPath = folders[0];
                console.log('[webview] loadDicomfolder:', folderPath);
                updateStatus('Loading DICOM folder...');
                // Request via the same requestFileContent pipeline; server will accept a directory
                const callbackId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                window[callbackId] = function(response) {
                    delete window[callbackId];
                    if (!response || response.error) {
                        console.error('[webview] loadDicomfolder error', response && response.error);
                        return;
                    }
                    // Response follows NIfTI structure (axial/sagittal/coronal or single)
                    currentNiftiFile = folderPath;
                    const slicesInfo = response?.slices || {};
                    currentSlices = slicesInfo.axial || 1;
                    currentSliceIndex = (response?.axial?.sliceIndex) || Math.floor(currentSlices / 2);
                    try {
                        if (axialSliceRange) { axialSliceRange.min = '1'; axialSliceRange.max = String(slicesInfo.axial || currentSlices); axialSliceRange.value = String((response?.axial?.sliceIndex ?? currentSliceIndex) + 1); }
                        if (sagittalSliceRange) { sagittalSliceRange.min = '1'; sagittalSliceRange.max = String(slicesInfo.sagittal || 1); sagittalSliceRange.value = String((response?.sagittal?.sliceIndex ?? Math.floor((slicesInfo.sagittal || 1)/2)) + 1); }
                        if (coronalSliceRange) { coronalSliceRange.min = '1'; coronalSliceRange.max = String(slicesInfo.coronal || 1); coronalSliceRange.value = String((response?.coronal?.sliceIndex ?? Math.floor((slicesInfo.coronal || 1)/2)) + 1); }
                        if (axialSliceLabel) axialSliceLabel.textContent = (parseInt(axialSliceRange?.value || '1', 10)) + '/' + (axialSliceRange?.max || '1');
                        if (sagittalSliceLabel) sagittalSliceLabel.textContent = (parseInt(sagittalSliceRange?.value || '1', 10)) + '/' + (sagittalSliceRange?.max || '1');
                        if (coronalSliceLabel) coronalSliceLabel.textContent = (parseInt(coronalSliceRange?.value || '1', 10)) + '/' + (coronalSliceRange?.max || '1');
                        axialSliceIndex = (response?.axial?.sliceIndex) || currentSliceIndex;
                        sagittalSliceIndex = (response?.sagittal?.sliceIndex) || Math.floor((slicesInfo.sagittal || 1)/2);
                        coronalSliceIndex = (response?.coronal?.sliceIndex) || Math.floor((slicesInfo.coronal || 1)/2);
                    } catch (e) {}
                    displayNiftiData(response);
                    updateStatus('DICOM folder loaded');
                };
                vscode.postMessage({ type: 'requestFileContent', filePath: folderPath, callbackId });
            } catch (e) {
                updateStatus('Error loading DICOM folder: ' + (e?.message || String(e)));
            }
        }
        
        // Request file content
        function requestFileContent(filePath) {
            return new Promise(function(resolve, reject) {
                const callbackId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                
                window[callbackId] = function(response) {
                    const contentLen = response?.content ? response.content.length : 0;
                    const binaryLen = response?.contentBinary ? response.contentBinary.byteLength : 0;
                    console.log('[webview] callback response for', filePath, '=>', response?.type, 'rows=', response?.rows, 'cols=', response?.columns, 'contentLen=', contentLen, 'binaryLen=', binaryLen);
                    delete window[callbackId];
                    if (response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                };
                
                vscode.postMessage({
                    type: 'requestFileContent',
                    filePath: filePath,
                    callbackId: callbackId
                });
                console.log('[webview] posted requestFileContent for', filePath, 'with callbackId', callbackId);
            });
        }
        
        // Convert Base64 string to ArrayBuffer
        function base64ToArrayBuffer(base64) {
            const binaryString = window.atob(base64);
            const binaryLen = binaryString.length;
            const bytes = new Uint8Array(binaryLen);
            for (let i = 0; i < binaryLen; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes.buffer;
        }

        // Request full file content object (used for NIfTI)
        function requestNiftiFileContent(filePath) {
            return new Promise(function(resolve, reject) {
                const callbackId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                window[callbackId] = function(response) {
                    delete window[callbackId];
                    if (response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                };
                vscode.postMessage({
                    type: 'requestFileContent',
                    filePath: filePath,
                    callbackId: callbackId
                });
                console.log('[webview] posted requestNiftiFileContent for', filePath, 'with callbackId', callbackId);
            });
        }

        // Load NIfTI files via Python slice results and draw on canvas
        async function loadNiftiFiles(filePaths) {
            try {
                updateStatus('Loading ' + filePaths.length + ' NIfTI files...');
                for (let i = 0; i < filePaths.length; i++) {
                    updateStatus('Processing NIfTI file ' + (i + 1) + ' of ' + filePaths.length);
                    try {
                const result = await requestNiftiFileContent(filePaths[i]);
                        console.log('[webview] NIfTI response:', {
                            rows: result?.rows,
                            columns: result?.columns,
                            metaShape: result?.metadata?.shape,
                            contentLen: (result?.content || '').length
                        });
                        // Accept either multi-plane (axial/sagittal/coronal) or single-plane (pixelData/content)
                        if (result && (result.axial || result.pixelData || result.content)) {
                            currentNiftiFile = filePaths[i];
                    // axial slices count preferred if available
                    const slicesInfo = result?.slices;
                    currentSlices = (slicesInfo && slicesInfo.axial) || (Array.isArray(result?.metadata?.shape) ? result.metadata.shape[2] : (result?.rows ? result.rows : 1)) || 1;
                    currentSliceIndex = (result?.axial?.sliceIndex) || Math.floor(currentSlices / 2);
                            // Initialize per-plane sliders if available
                            try {
                                const s = result?.slices || {};
                                if (axialSliceRange) { axialSliceRange.min = '1'; axialSliceRange.max = String(s.axial || currentSlices); axialSliceRange.value = String((result?.axial?.sliceIndex ?? currentSliceIndex) + 1); }
                                if (sagittalSliceRange) { sagittalSliceRange.min = '1'; sagittalSliceRange.max = String(s.sagittal || 1); sagittalSliceRange.value = String((result?.sagittal?.sliceIndex ?? Math.floor((s.sagittal || 1)/2)) + 1); }
                                if (coronalSliceRange) { coronalSliceRange.min = '1'; coronalSliceRange.max = String(s.coronal || 1); coronalSliceRange.value = String((result?.coronal?.sliceIndex ?? Math.floor((s.coronal || 1)/2)) + 1); }
                                if (axialSliceLabel) axialSliceLabel.textContent = (parseInt(axialSliceRange?.value || '1', 10)) + '/' + (axialSliceRange?.max || '1');
                                if (sagittalSliceLabel) sagittalSliceLabel.textContent = (parseInt(sagittalSliceRange?.value || '1', 10)) + '/' + (sagittalSliceRange?.max || '1');
                                if (coronalSliceLabel) coronalSliceLabel.textContent = (parseInt(coronalSliceRange?.value || '1', 10)) + '/' + (coronalSliceRange?.max || '1');
                                axialSliceIndex = (result?.axial?.sliceIndex) || currentSliceIndex;
                                sagittalSliceIndex = (result?.sagittal?.sliceIndex) || Math.floor((s.sagittal || 1)/2);
                                coronalSliceIndex = (result?.coronal?.sliceIndex) || Math.floor((s.coronal || 1)/2);
                            } catch (e) {}
                            displayNiftiData(result);
                        } else {
                            console.error('Invalid NIfTI response for', filePaths[i]);
                        }
                    } catch (e) {
                        console.error('Failed to load NIfTI', e);
                    }
                }
                updateStatus('Finished loading NIfTI files');
            } catch (e) {
                updateStatus('Error loading NIfTI files: ' + e.message);
            }
        }

        function requestSegAllPlanes() {
            try {
                if (!currentSegFiles || currentSegFiles.length === 0) return;
                const segPath = currentSegFiles[0];
                function requestSegPlane(plane, index) {
                    const cbId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    window[cbId] = function(response) {
                        delete window[cbId];
                        if (!response || response.error) return;
                        // response will be routed in fileContent handler with isSeg flag
                    };
                    vscode.postMessage({
                        type: 'requestFileContent',
                        filePath: segPath,
                        callbackId: cbId,
                        sliceIndex: index,
                        plane: plane,
                        isSeg: true
                    });
                }
                requestSegPlane('axial', axialSliceIndex);
                requestSegPlane('sagittal', sagittalSliceIndex);
                requestSegPlane('coronal', coronalSliceIndex);
            } catch (e) {}
        }

        // Per-plane sliders: update label while dragging, request slice on release
        (function() {
            function attachSliderHandlers(rangeEl, labelEl, plane, getMax) {
                if (!rangeEl) return;
                let pendingIndex = 0;
                let lastRequested = -1;
                const updateLabel = function() {
                    const maxVal = parseInt(getMax() || '1', 10);
                    const oneBased = parseInt(rangeEl.value, 10);
                    const newIndex = Math.max(1, Math.min(maxVal, oneBased)) - 1;
                    pendingIndex = newIndex;
                    if (labelEl) labelEl.textContent = (newIndex + 1) + '/' + maxVal;
                };
                const requestSlice = function() {
                    try {
                        if (!currentNiftiFile) return;
                        if (pendingIndex === lastRequested) return;
                        lastRequested = pendingIndex;
                        if (plane === 'axial') axialSliceIndex = pendingIndex;
                        if (plane === 'sagittal') sagittalSliceIndex = pendingIndex;
                        if (plane === 'coronal') coronalSliceIndex = pendingIndex;
                        const callbackId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                        window[callbackId] = function(response) {
                            delete window[callbackId];
                            if (!response || response.error) {
                                console.error('[webview] slice request error', response?.error);
                                return;
                            }
                            displayNiftiData(response);
                        };
                const wcInput = document.getElementById('wl-center');
                const wwInput = document.getElementById('wl-width');
                const wc = parseFloat(wcInput && wcInput.value);
                const ww = parseFloat(wwInput && wwInput.value);
                vscode.postMessage({
                    type: 'requestFileContent',
                    filePath: currentNiftiFile,
                    callbackId: callbackId,
                    sliceIndex: pendingIndex,
                    plane: plane,
                    windowCenter: Number.isFinite(wc) ? wc : undefined,
                    windowWidth: Number.isFinite(ww) ? ww : undefined
                });
                        // Also request segmentation overlay for the same plane/index if available
                        try {
                            if (currentSegFiles && currentSegFiles.length > 0) {
                                const segCbId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                                window[segCbId] = function(response) {
                                    delete window[segCbId];
                                    if (!response || response.error) return;
                                    // handled in fileContent with isSeg flag, but also draw here for responsiveness
                                    displayNiftiData(response);
                                };
                                vscode.postMessage({
                                    type: 'requestFileContent',
                                    filePath: currentSegFiles[0],
                                    callbackId: segCbId,
                                    sliceIndex: pendingIndex,
                                    plane: plane,
                                    isSeg: true
                                });
                            }
                        } catch (e) {}
                        console.log('[webview] requested', plane, 'slice (release)', pendingIndex, 'for', currentNiftiFile, 'callbackId', callbackId);
                    } catch (e) {
                        console.error('[webview] slice slider error', e);
                    }
                };
                rangeEl.addEventListener('input', updateLabel);
                rangeEl.addEventListener('change', requestSlice);
                rangeEl.addEventListener('mouseup', requestSlice);
                rangeEl.addEventListener('touchend', requestSlice);
            }
            attachSliderHandlers(axialSliceRange, axialSliceLabel, 'axial', function() { return axialSliceRange && axialSliceRange.max; });
            attachSliderHandlers(sagittalSliceRange, sagittalSliceLabel, 'sagittal', function() { return sagittalSliceRange && sagittalSliceRange.max; });
            attachSliderHandlers(coronalSliceRange, coronalSliceLabel, 'coronal', function() { return coronalSliceRange && coronalSliceRange.max; });
        })();

        // Segmentation overlay state and composite rendering
        let segOpacity = 0.4;
        const segOpacityRange = document.getElementById('seg-opacity-range');
        const segOpacityLabel = document.getElementById('seg-opacity-label');
        if (segOpacityRange) {
            segOpacityRange.addEventListener('input', function() {
                const val = Math.max(0, Math.min(100, parseInt(segOpacityRange.value || '0', 10)));
                segOpacity = val / 100;
                if (segOpacityLabel) segOpacityLabel.textContent = val + '%';
                // Redraw composites with new opacity
                drawComposite('axial', axialElement);
                drawComposite('sagittal', sagittalElement);
                drawComposite('coronal', coronalElement);
                drawComposite('axial', volumeElement);
            });
        }

        const baseCache = { axial: null, sagittal: null, coronal: null };
        const segCache = { axial: null, sagittal: null, coronal: null };

        // Mouse wheel slice scrolling for per-plane views (NIfTI) - immediate updates (no debounce)
        (function() {
            try {
                const inFlight = { axial: false, sagittal: false, coronal: false };
                const latestRequested = { axial: null, sagittal: null, coronal: null };

                function sendPlaneSlice(plane, clamped) {
                    if (!currentNiftiFile) return;
                    inFlight[plane] = true;
                    const callbackId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    window[callbackId] = function(response) {
                        delete window[callbackId];
                        inFlight[plane] = false;
                        if (response && !response.error) {
                            displayNiftiData(response);
                        }
                        // If a newer request is queued for this plane, send it now
                        const next = latestRequested[plane];
                        if (next !== null && next !== undefined) {
                            latestRequested[plane] = null;
                            requestPlaneSlice(plane, next);
                        }
                    };
                    const wcInput = document.getElementById('wl-center');
                    const wwInput = document.getElementById('wl-width');
                    const wc = parseFloat(wcInput && wcInput.value);
                    const ww = parseFloat(wwInput && wwInput.value);
                    vscode.postMessage({
                        type: 'requestFileContent',
                        filePath: currentNiftiFile,
                        callbackId: callbackId,
                        sliceIndex: clamped,
                        plane: plane,
                        windowCenter: Number.isFinite(wc) ? wc : undefined,
                        windowWidth: Number.isFinite(ww) ? ww : undefined
                    });
                    // Request segmentation overlay if available
                    try {
                        if (currentSegFiles && currentSegFiles.length > 0) {
                            const segCbId = 'callback_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                            window[segCbId] = function(response) {
                                delete window[segCbId];
                                if (response && !response.error) {
                                    displayNiftiData(response);
                                }
                            };
                            vscode.postMessage({
                                type: 'requestFileContent',
                                filePath: currentSegFiles[0],
                                callbackId: segCbId,
                                sliceIndex: clamped,
                                plane: plane,
                                isSeg: true
                            });
                        }
                    } catch (e) {}
                }

                function requestPlaneSlice(plane, targetIndex) {
                    try {
                        if (!currentNiftiFile) return;
                        // Clamp and update indices and UI
                        const rangeEl = plane === 'axial' ? axialSliceRange : (plane === 'sagittal' ? sagittalSliceRange : coronalSliceRange);
                        const labelEl = plane === 'axial' ? axialSliceLabel : (plane === 'sagittal' ? sagittalSliceLabel : coronalSliceLabel);
                        const maxVal = parseInt((rangeEl && rangeEl.max) || '1', 10);
                        const clamped = Math.max(0, Math.min(maxVal - 1, targetIndex|0));
                        if (plane === 'axial') axialSliceIndex = clamped;
                        if (plane === 'sagittal') sagittalSliceIndex = clamped;
                        if (plane === 'coronal') coronalSliceIndex = clamped;
                        if (rangeEl) rangeEl.value = String(clamped + 1);
                        if (labelEl) labelEl.textContent = (clamped + 1) + '/' + (maxVal || 1);

                        if (inFlight[plane]) {
                            latestRequested[plane] = clamped;
                            return;
                        }
                        latestRequested[plane] = null;
                        sendPlaneSlice(plane, clamped);
                    } catch (e) {}
                }

                function attachWheel(el, plane) {
                    if (!el) return;
                    el.addEventListener('wheel', function(ev) {
                        try {
                            ev.preventDefault();
                            // Calculate target slice immediately
                            const delta = ev.deltaY || 0;
                            const step = delta > 0 ? 1 : -1;
                            const rangeEl = plane === 'axial' ? axialSliceRange : (plane === 'sagittal' ? sagittalSliceRange : coronalSliceRange);
                            const maxVal = parseInt((rangeEl && rangeEl.max) || '1', 10);
                            const currentOneBased = parseInt((rangeEl && rangeEl.value) || '1', 10);
                            const current = Math.max(1, Math.min(maxVal, currentOneBased)) - 1;
                            const next = Math.max(0, Math.min(maxVal - 1, current + step));
                            if (next === current) return;
                            // Update UI and request immediately (with in-flight coalescing)
                            requestPlaneSlice(plane, next);
                        } catch (e) {}
                    }, { passive: false });
                }

                attachWheel(axialElement, 'axial');
                attachWheel(sagittalElement, 'sagittal');
                attachWheel(coronalElement, 'coronal');
                // Do not attach 2D scrolling to 3D View panel
            } catch (e) { console.warn('wheel init error', e); }
        })();

        function drawGrayscale(ctx, columns, rows, base64Gray) {
            const bin = window.atob(base64Gray);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
            const imageData = ctx.createImageData(columns, rows);
            for (let i = 0; i < bytes.length; i++) {
                const idx = i * 4;
                const v = bytes[i];
                imageData.data[idx + 0] = v;
                imageData.data[idx + 1] = v;
                imageData.data[idx + 2] = v;
                imageData.data[idx + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
        }

        function overlaySegOnto(ctx, columns, rows, base64Seg, opacity) {
            const bin = window.atob(base64Seg);
            const n = bin.length;
            const labels = new Uint8Array(n);
            for (let i = 0; i < n; i++) labels[i] = bin.charCodeAt(i) & 0xFF;
            const segImage = ctx.getImageData(0, 0, columns, rows);
            const lut = [
                [0, 0, 0],
                [255, 0, 0],
                [0, 255, 0],
                [0, 0, 255],
                [255, 255, 0],
                [255, 0, 255],
                [0, 255, 255]
            ];
            const alpha = Math.max(0, Math.min(1, opacity));
            for (let i = 0; i < n; i++) {
                const label = labels[i];
                if (!label) continue;
                const [r, g, b] = lut[label % lut.length];
                const idx = i * 4;
                segImage.data[idx + 0] = Math.round((1 - alpha) * segImage.data[idx + 0] + alpha * r);
                segImage.data[idx + 1] = Math.round((1 - alpha) * segImage.data[idx + 1] + alpha * g);
                segImage.data[idx + 2] = Math.round((1 - alpha) * segImage.data[idx + 2] + alpha * b);
            }
            ctx.putImageData(segImage, 0, 0);
        }

        function drawComposite(plane, container) {
            try {
                const base = baseCache[plane];
                if (!container || !base || !base.pixelData) return;
                const columns = base.columns;
                const rows = base.rows;
                // Guard: never replace 3D view content when drawing 2D
                if (container === volumeElement) return;
                container.innerHTML = '';
                const canvas = document.createElement('canvas');
                canvas.width = columns;
                canvas.height = rows;
                container.appendChild(canvas);
                const ctx = canvas.getContext('2d');
                drawGrayscale(ctx, columns, rows, base.pixelData);
                const seg = segCache[plane];
                if (seg && seg.pixelData && segOpacity > 0) {
                    overlaySegOnto(ctx, columns, rows, seg.pixelData, segOpacity);
                }
            } catch (e) {}
        }

        // vtk.js-based OBJ renderer in 3D View
        let currentVtkPipeline = null; // track objects to allow cleanup
        let pendingVtkRetryTimer = null;
        
        function renderOBJInVolume(objData, options = {}) {
            // Unified OBJ rendering function that handles both single and multiple OBJ files
            // objData can be:
            // 1. ArrayBuffer (single OBJ, legacy)
            // 2. {arrayBuffer, color} (single OBJ, structured)
            // 3. Array of {objBase64, label, color, path} (multiple OBJs)
            
            try {
                // Normalize input data to unified format
                let objFiles = [];
                
                if (objData instanceof ArrayBuffer) {
                    // Legacy single OBJ format
                    objFiles = [{
                        arrayBuffer: objData,
                        label: 1,
                        color: options.color || [0.8, 0.9, 1.0],
                        isLegacy: true
                    }];
                } else if (objData && objData.arrayBuffer) {
                    // Structured single OBJ format
                    objFiles = [{
                        arrayBuffer: objData.arrayBuffer,
                        label: objData.label || 1,
                        color: objData.color || options.color || [0.8, 0.9, 1.0],
                        isLegacy: true
                    }];
                } else if (Array.isArray(objData)) {
                    // Multiple OBJ files format
                    console.log('[webview] Processing multi-OBJ array with', objData.length, 'items');
                    objFiles = objData.filter(obj => obj && (obj.objBase64 || obj.arrayBuffer));
                    console.log('[webview] After filtering, valid OBJ files:', objFiles.length);
                    objFiles.forEach((obj, idx) => {
                        console.log('[webview] OBJ ' + (idx + 1) + ': label=' + obj.label + ', hasObjBase64=' + (!!obj.objBase64) + ', hasArrayBuffer=' + (!!obj.arrayBuffer) + ', color=' + JSON.stringify(obj.color));
                    });
                } else {
                    console.error('[webview] Invalid objData format:', typeof objData);
                    try { updateStatus('Invalid OBJ data format'); } catch (e) {}
                    return;
                }
                
                if (objFiles.length === 0) {
                    console.warn('[webview] No valid OBJ files to render');
                    try { updateStatus('No valid OBJ files to render'); } catch (e) {}
                    return;
                }
                
                console.log('[webview] Unified OBJ rendering:', objFiles.length, 'objects');
                try { vscode.postMessage({ type: 'debug', text: 'Unified OBJ rendering: ' + objFiles.length + ' objects' }); } catch (e) {}
                
                const container = volumeElement;
                if (!container || typeof vtk === 'undefined') {
                    console.warn('vtk.js not available or container missing');
                    try { updateStatus('vtk.js not ready or container missing'); } catch (e) {}
                    return;
                }
                
                // Clear previous content and dispose previous renderer
                try {
                    if (currentVtkPipeline) {
                        try { currentVtkPipeline.interactor && currentVtkPipeline.interactor.delete && currentVtkPipeline.interactor.delete(); } catch (e) {}
                        try { currentVtkPipeline.openGLRenderWindow && currentVtkPipeline.openGLRenderWindow.delete && currentVtkPipeline.openGLRenderWindow.delete(); } catch (e) {}
                        try { currentVtkPipeline.mapper && currentVtkPipeline.mapper.delete && currentVtkPipeline.mapper.delete(); } catch (e) {}
                        try { currentVtkPipeline.actor && currentVtkPipeline.actor.delete && currentVtkPipeline.actor.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderer && currentVtkPipeline.renderer.delete && currentVtkPipeline.renderer.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderWindow && currentVtkPipeline.renderWindow.delete && currentVtkPipeline.renderWindow.delete(); } catch (e) {}
                        currentVtkPipeline = null;
                    }
                    if (container && container.firstChild) {
                        while (container.firstChild) {
                            container.removeChild(container.firstChild);
                        }
                    }
                } catch (e) {}
                
                // Setup container styles
                container.innerHTML = '';
                container.style.position = 'relative';
                container.style.overflow = 'hidden';
                container.style.background = '#000';
                try {
                    const rect = container.getBoundingClientRect();
                    if (!rect || rect.height < 10) {
                        container.style.minHeight = '220px';
                    }
                } catch (e) {}
                
                // Ensure required vtk namespaces are present
                if (!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader && vtk.Rendering && vtk.Rendering.Core && vtk.Rendering.OpenGL)) {
                    console.error('vtk missing required modules for OBJ:', {
                        Misc: !!(vtk && vtk.IO && vtk.IO.Misc), 
                        OBJ: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                        Rendering: !!(vtk && vtk.Rendering), 
                        Core: !!(vtk && vtk.Rendering && vtk.Rendering.Core), 
                        OpenGL: !!(vtk && vtk.Rendering && vtk.Rendering.OpenGL)
                    });
                    try { updateStatus('vtk.js OBJ modules missing'); } catch (e) {}
                    return;
                }
                
                // Create renderer and render window
                let renderer = null;
                let renderWindow = null;
                let interactor = null;
                let openGLRenderWindow = null;
                let usingFallbackFSR = false;
                
                try {
                    // Primary rendering setup
                    renderWindow = vtk.Rendering.Core.vtkRenderWindow.newInstance();
                    renderer = vtk.Rendering.Core.vtkRenderer.newInstance();
                    renderer.setBackground(objFiles.length > 1 ? 0.1 : 0, objFiles.length > 1 ? 0.1 : 0, objFiles.length > 1 ? 0.15 : 0);
                    renderWindow.addRenderer(renderer);
                    
                    openGLRenderWindow = vtk.Rendering.OpenGL.vtkRenderWindow.newInstance();
                    openGLRenderWindow.setContainer(container);
                    renderWindow.addView(openGLRenderWindow);
                    
                    interactor = vtk.Rendering.Core.vtkRenderWindowInteractor.newInstance();
                    interactor.setView(openGLRenderWindow);
                    interactor.initialize();
                    interactor.bindEvents(container);
                    
                    // Set interaction style
                    try {
                        if (vtk && vtk.Interaction && vtk.Interaction.Style && vtk.Interaction.Style.vtkInteractorStyleTrackballCamera) {
                            const style = vtk.Interaction.Style.vtkInteractorStyleTrackballCamera.newInstance();
                            interactor.setInteractorStyle(style);
                        }
                    } catch (e) {}
                    
                    console.log('[webview] VTK renderer setup complete for', objFiles.length, 'objects');
                    console.log('[webview] Container dimensions:', container.getBoundingClientRect());
                    console.log('[webview] OpenGL render window container set:', !!openGLRenderWindow);
                    
                    try { vscode.postMessage({ type: 'debug', text: 'VTK renderer setup complete for ' + objFiles.length + ' objects' }); } catch (e) {}
                    const rect = container.getBoundingClientRect();
                    try { vscode.postMessage({ type: 'debug', text: 'Container dimensions: ' + rect.width + 'x' + rect.height }); } catch (e) {}
                    
                } catch (e) {
                    // Fallback to FullScreenRenderWindow for legacy single OBJ
                    if (objFiles.length === 1 && objFiles[0].isLegacy) {
                        try {
                            const fsr = vtk.Rendering.Misc.vtkFullScreenRenderWindow.newInstance({
                                rootContainer: container,
                                container: container,
                                background: [0, 0, 0]
                            });
                            renderer = fsr.getRenderer();
                            renderWindow = fsr.getRenderWindow();
                            usingFallbackFSR = true;
                        } catch (e2) {
                            console.error('Failed to create vtk renderer:', e2);
                            try { updateStatus('Failed to create vtk renderer'); } catch (e3) {}
                            return;
                        }
                    } else {
                        console.error('Failed to create vtk renderer:', e);
                        try { updateStatus('Failed to create vtk renderer'); } catch (e2) {}
                        return;
                    }
                }
                
                // Process each OBJ file
                console.log('[webview] About to process', objFiles.length, 'OBJ files');
                console.log('[webview] Renderer exists:', !!renderer, 'RenderWindow exists:', !!renderWindow);
                
                let successCount = 0;
                for (const objFile of objFiles) {
                    try {
                        let objData = null;
                        
                        // Convert data to uniform format
                        if (objFile.arrayBuffer) {
                            // Legacy format or structured single OBJ
                            objData = objFile.arrayBuffer;
                        } else if (objFile.objBase64) {
                            // Multi-OBJ format - decode base64
                            const bin = window.atob(objFile.objBase64);
                            const n = bin.length;
                            const bytes = new Uint8Array(n);
                            for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
                            objData = bytes.buffer;
                        } else {
                            console.warn('[webview] OBJ file missing data for label:', objFile.label);
                            continue;
                        }
                        
                        console.log('[webview] Processing OBJ for label:', objFile.label, 'color:', objFile.color);
                        
                        // Create OBJ reader
                        const reader = vtk.IO.Misc.vtkOBJReader.newInstance();
                        try {
                            // Try parsing as text first (more reliable for OBJ format)
                            const txt = new TextDecoder('utf-8').decode(new Uint8Array(objData));
                            reader.parseAsText(txt);
                        } catch (e) {
                            // Fallback to array buffer parsing
                            console.warn('OBJ text parsing failed, using array buffer for label:', objFile.label);
                            reader.parseAsArrayBuffer(objData);
                        }
                        
                        const polydata = reader.getOutputData();
                        if (!polydata || polydata.getNumberOfPoints() === 0) {
                            console.warn('No geometry parsed from OBJ for label:', objFile.label);
                            continue;
                        }
                        
                        // Create mapper and actor
                        const mapper = vtk.Rendering.Core.vtkMapper.newInstance();
                        mapper.setInputData(polydata);
                        const actor = vtk.Rendering.Core.vtkActor.newInstance();
                        actor.setMapper(mapper);
                        
                        // Set color
                        if (objFile.color && Array.isArray(objFile.color) && objFile.color.length >= 3) {
                            try { 
                                actor.getProperty().setColor(objFile.color[0], objFile.color[1], objFile.color[2]); 
                            } catch (e) {
                                console.warn('Failed to set color for label:', objFile.label, e);
                            }
                        } else {
                            // Fallback colors
                            const fallbackColor = objFiles.length === 1 ? [0.8, 0.9, 1.0] : [0.8, 0.8, 0.8];
                            try { actor.getProperty().setColor(fallbackColor[0], fallbackColor[1], fallbackColor[2]); } catch (e) {}
                        }
                        
                        // Set opacity
                        try { 
                            const opacity = objFiles.length > 1 ? 0.8 : 1.0;
                            actor.getProperty().setOpacity(opacity); 
                        } catch (e) {}
                        
                        // Add actor to renderer
                        console.log('[webview] About to add actor to renderer for label:', objFile.label);
                        console.log('[webview] Actor exists:', !!actor, 'Renderer exists:', !!renderer);
                        
                        if (renderer && actor) {
                            renderer.addActor(actor);
                            successCount++;
                            
                            console.log('[webview] Successfully added OBJ actor for label:', objFile.label, 
                                      'with', polydata.getNumberOfPoints(), 'points,', 
                                      polydata.getNumberOfCells(), 'cells, color:', objFile.color);
                            
                            try { vscode.postMessage({ type: 'debug', text: 'Successfully added OBJ actor for label ' + objFile.label + ' with ' + polydata.getNumberOfPoints() + ' points' }); } catch (e) {}
                            
                            // Debug: check if actor was actually added to renderer
                            const currentActors = renderer.getActors ? renderer.getActors().length : 'unknown';
                            console.log('[webview] Current actors in renderer:', currentActors);
                            try { vscode.postMessage({ type: 'debug', text: 'Current actors in renderer: ' + currentActors }); } catch (e) {}
                        } else {
                            console.error('[webview] Cannot add actor - renderer or actor is null');
                            try { vscode.postMessage({ type: 'debug', text: 'ERROR: Cannot add actor - renderer or actor is null' }); } catch (e) {}
                        }
                        
                    } catch (e) {
                        console.error('Error processing OBJ for label:', objFile.label, e);
                    }
                }
                
                if (successCount === 0) {
                    console.warn('[webview] No OBJ files were successfully processed');
                    try { updateStatus('Failed to process any OBJ files'); } catch (e) {}
                    return;
                }
                
                // Setup resize function (only if not using fallback)
                if (!usingFallbackFSR) {
                    function resize() {
                        try {
                            const rect = container.getBoundingClientRect();
                            if (!rect) return;
                            if (openGLRenderWindow && rect.width > 0 && rect.height > 0) {
                                openGLRenderWindow.setSize(Math.floor(rect.width), Math.floor(rect.height));
                            }
                            if (renderWindow) renderWindow.render();
                        } catch (e) {}
                    }
                    
                    // Setup resizing and events
                    resize();
                    setTimeout(resize, 50);
                    window.addEventListener('resize', resize);
                    
                    // Add interaction events
                    try {
                        container.addEventListener('contextmenu', function(ev){ try { ev.preventDefault(); } catch (e) {} });
                        container.addEventListener('dblclick', function(){
                            try { renderer.resetCamera(); renderWindow && renderWindow.render(); } catch (e) {}
                        });
                    } catch (e) {}
                } else {
                    // Legacy fallback resize setup
                    function resize() {
                        try {
                            const rect2 = container.getBoundingClientRect();
                            if (!rect2) return;
                            if (openGLRenderWindow && rect2.width > 0 && rect2.height > 0) {
                                openGLRenderWindow.setSize(Math.floor(rect2.width), Math.floor(rect2.height));
                            }
                            if (renderWindow) renderWindow.render();
                        } catch (e) {}
                    }
                    resize();
                    setTimeout(resize, 50);
                    window.addEventListener('resize', resize);
                }
                
                // Initial render
                console.log('[webview] Starting final render with', successCount, 'objects');
                
                // Check container and renderer state before rendering
                const containerRect = container.getBoundingClientRect();
                console.log('[webview] Container rect before render:', containerRect);
                console.log('[webview] Container has children:', container.children.length);
                
                if (renderer) {
                    renderer.resetCamera();
                    console.log('[webview] Camera reset completed');
                }
                
                if (renderWindow) {
                    renderWindow.render();
                    console.log('[webview] RenderWindow.render() completed');
                } else {
                    console.error('[webview] RenderWindow is null, cannot render');
                }
                
                console.log('[webview] Unified OBJ rendering complete, objects:', successCount);
                try { vscode.postMessage({ type: 'debug', text: 'Unified OBJ rendering complete, objects: ' + successCount }); } catch (e) {}
                
                // Debug: verify renderer state
                const finalActorCount = renderer && renderer.getActors ? renderer.getActors().length : 'unknown';
                console.log('[webview] Final verification - actors in renderer:', finalActorCount);
                try { vscode.postMessage({ type: 'debug', text: 'Final verification - actors in renderer: ' + finalActorCount }); } catch (e) {}
                
                // Try to force a re-render after a delay
                setTimeout(() => {
                    try {
                        if (renderWindow) {
                            console.log('[webview] Forcing delayed re-render');
                            renderWindow.render();
                        }
                    } catch (e) {
                        console.error('[webview] Error in delayed re-render:', e);
                    }
                }, 100);
                
                // Store pipeline for cleanup
                currentVtkPipeline = { 
                    interactor, 
                    openGLRenderWindow, 
                    renderer, 
                    renderWindow, 
                    usingFallbackFSR,
                    // Store first actor and mapper for legacy compatibility
                    actor: renderer.getActors ? renderer.getActors()[0] : null,
                    mapper: renderer.getActors && renderer.getActors()[0] ? renderer.getActors()[0].getMapper() : null
                };
                
                // Update status
                const statusMsg = successCount === 1 ? 
                    'OBJ rendered in Volume Preview' : 
                    'Multi-label OBJ rendered: ' + successCount + ' objects in Volume Preview';
                try { updateStatus(statusMsg); } catch (e) {}
                
            } catch (e) {
                console.error('renderOBJInVolume error', e);
                try { updateStatus('Failed to render OBJ'); } catch (e2) {}
            }
        }
        
        // Legacy wrapper for backward compatibility
        function renderMultiOBJInVolume(objFiles) {
            console.log('[webview] renderMultiOBJInVolume (legacy) called with', objFiles?.length, 'files');
            try { vscode.postMessage({ type: 'debug', text: 'renderMultiOBJInVolume (legacy) called with ' + (objFiles?.length || 0) + ' files' }); } catch (e) {}
            // Delegate to unified function
            renderOBJInVolume(objFiles);
        }
        
        // Delete this old function - kept for reference during transition
        function _oldRenderMultiOBJInVolume(objFiles) {
            try {
                const container = volumeElement;
                if (!container || typeof vtk === 'undefined') {
                    console.warn('vtk.js not available or container missing');
                    try { updateStatus('vtk.js not ready or container missing'); } catch (e) {}
                    return;
                }
                
                // Clear previous content and dispose previous renderer
                try {
                    if (currentVtkPipeline) {
                        try { currentVtkPipeline.interactor && currentVtkPipeline.interactor.delete && currentVtkPipeline.interactor.delete(); } catch (e) {}
                        try { currentVtkPipeline.openGLRenderWindow && currentVtkPipeline.openGLRenderWindow.delete && currentVtkPipeline.openGLRenderWindow.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderer && currentVtkPipeline.renderer.delete && currentVtkPipeline.renderer.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderWindow && currentVtkPipeline.renderWindow.delete && currentVtkPipeline.renderWindow.delete(); } catch (e) {}
                        currentVtkPipeline = null;
                    }
                    if (container && container.firstChild) {
                        while (container.firstChild) {
                            container.removeChild(container.firstChild);
                        }
                    }
                } catch (e) {}
                
                // Ensure required vtk namespaces are present
                if (!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader && vtk.Rendering && vtk.Rendering.Core && vtk.Rendering.OpenGL)) {
                    console.error('vtk missing required modules for OBJ:', {
                        Misc: !!(vtk && vtk.IO && vtk.IO.Misc), 
                        OBJ: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                        Rendering: !!(vtk && vtk.Rendering), 
                        Core: !!(vtk && vtk.Rendering && vtk.Rendering.Core), 
                        OpenGL: !!(vtk && vtk.Rendering && vtk.Rendering.OpenGL)
                    });
                    try { updateStatus('vtk.js OBJ modules missing'); } catch (e) {}
                    return;
                }
                
                // Create renderer and render window
                const renderer = vtk.Rendering.Core.vtkRenderer.newInstance();
                const renderWindow = vtk.Rendering.Core.vtkRenderWindow.newInstance();
                renderWindow.addRenderer(renderer);
                
                // Create OpenGL render window
                const openGLRenderWindow = vtk.Rendering.OpenGL.vtkRenderWindow.newInstance();
                openGLRenderWindow.setContainer(container);
                renderWindow.addView(openGLRenderWindow);
                
                // Create interactor
                const interactor = vtk.Rendering.Core.vtkRenderWindowInteractor.newInstance();
                interactor.setView(openGLRenderWindow);
                interactor.initialize();
                interactor.bindEvents(container);
                
                // Set interaction style
                try {
                    if (vtk && vtk.Interaction && vtk.Interaction.Style && vtk.Interaction.Style.vtkInteractorStyleTrackballCamera) {
                        const style = vtk.Interaction.Style.vtkInteractorStyleTrackballCamera.newInstance();
                        interactor.setInteractorStyle(style);
                    }
                } catch (e) {}
                
                // Set background
                renderer.setBackground(0.1, 0.1, 0.15);
                
                // Process each OBJ file
                console.log('[webview] Processing', objFiles.length, 'OBJ files for multi-label rendering');
                for (const objFile of objFiles) {
                    try {
                        if (!objFile.objBase64) {
                            console.warn('[webview] OBJ file missing base64 data for label:', objFile.label);
                            continue;
                        }
                        console.log('[webview] Processing OBJ for label:', objFile.label, 'color:', objFile.color);
                        
                        // Decode base64 to array buffer
                        const bin = window.atob(objFile.objBase64);
                        const n = bin.length;
                        const bytes = new Uint8Array(n);
                        for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
                        
                        // Create OBJ reader
                        const reader = vtk.IO.Misc.vtkOBJReader.newInstance();
                        try {
                            // First try parsing as text (more reliable for OBJ format)
                            const txt = new TextDecoder('utf-8').decode(bytes);
                            reader.parseAsText(txt);
                        } catch (e) {
                            // Fallback to array buffer parsing
                            console.warn('OBJ text parsing failed, using array buffer for label:', objFile.label);
                            reader.parseAsArrayBuffer(bytes.buffer);
                        }
                        const polydata = reader.getOutputData();
                        
                        if (!polydata || polydata.getNumberOfPoints() === 0) {
                            console.warn('No geometry parsed from OBJ for label:', objFile.label);
                            continue;
                        }
                        
                        // Create mapper and actor
                        const mapper = vtk.Rendering.Core.vtkMapper.newInstance();
                        mapper.setInputData(polydata);
                        const actor = vtk.Rendering.Core.vtkActor.newInstance();
                        actor.setMapper(mapper);
                        
                        // Set color from server response
                        if (objFile.color && Array.isArray(objFile.color) && objFile.color.length >= 3) {
                            try { 
                                actor.getProperty().setColor(objFile.color[0], objFile.color[1], objFile.color[2]); 
                            } catch (e) {
                                console.warn('Failed to set color for label:', objFile.label, e);
                            }
                        } else {
                            // Fallback color
                            try { actor.getProperty().setColor(0.8, 0.8, 0.8); } catch (e) {}
                        }
                        
                        // Set opacity
                        try { actor.getProperty().setOpacity(0.8); } catch (e) {}
                        
                        // Add actor to renderer
                        renderer.addActor(actor);
                        
                        console.log('[webview] Successfully added OBJ actor for label:', objFile.label, 
                                  'with', polydata.getNumberOfPoints(), 'points,', 
                                  polydata.getNumberOfCells(), 'cells, color:', objFile.color);
                        
                    } catch (e) {
                        console.error('Error processing OBJ for label:', objFile.label, e);
                    }
                }
                
                // Setup resize function
                function resize() {
                    try {
                        const rect = container.getBoundingClientRect();
                        if (!rect) return;
                        if (openGLRenderWindow && rect.width > 0 && rect.height > 0) {
                            openGLRenderWindow.setSize(Math.floor(rect.width), Math.floor(rect.height));
                        }
                        if (renderWindow) renderWindow.render();
                    } catch (e) {}
                }
                
                // Get final actor count
                const actorCount = renderer.getActors ? renderer.getActors().length : 0;
                console.log('[webview] Total actors added to renderer:', actorCount);
                
                // Initial render
                renderer.resetCamera();
                renderWindow.render();
                console.log('[webview] Initial render complete for multi-label OBJ');
                
                // Setup resizing
                resize();
                setTimeout(resize, 50);
                window.addEventListener('resize', resize);
                
                // Add double-click to reset camera
                try {
                    container.addEventListener('contextmenu', function(ev){ try { ev.preventDefault(); } catch (e) {} });
                    container.addEventListener('dblclick', function(){
                        try { renderer.resetCamera(); renderWindow && renderWindow.render(); } catch (e) {}
                    });
                } catch (e) {}
                
                // Store pipeline for cleanup
                currentVtkPipeline = { interactor, openGLRenderWindow, renderer, renderWindow };
                
                try { updateStatus('Multi-label OBJ rendered: ' + actorCount + ' objects in Volume Preview'); } catch (e) {}
                
            } catch (e) {
                console.error('renderMultiOBJInVolume (legacy) error', e);
                try { updateStatus('Failed to render multi-label OBJ'); } catch (e2) {}
            }
        }

        // Legacy single OBJ wrapper for backward compatibility  
        function renderOBJInVolumeLegacy(arrayBuffer, color) {
            console.log('[webview] renderOBJInVolumeLegacy (legacy) called');
            // Delegate to unified function
            renderOBJInVolume(arrayBuffer, {color: color});
        }
        
        // Delete this old function - kept for reference during transition
        function _oldRenderOBJInVolumeLegacy(arrayBuffer, color) {
            try {
                const container = volumeElement;
                if (!container || typeof vtk === 'undefined') {
                    console.warn('vtk.js not available or container missing');
                    try { updateStatus('vtk.js not ready or container missing'); } catch (e) {}
                    return;
                }
                // Clear previous content and dispose previous renderer
                try {
                    if (currentVtkPipeline) {
                        try { currentVtkPipeline.interactor && currentVtkPipeline.interactor.delete && currentVtkPipeline.interactor.delete(); } catch (e) {}
                        try { currentVtkPipeline.openGLRenderWindow && currentVtkPipeline.openGLRenderWindow.delete && currentVtkPipeline.openGLRenderWindow.delete(); } catch (e) {}
                        try { currentVtkPipeline.mapper && currentVtkPipeline.mapper.delete && currentVtkPipeline.mapper.delete(); } catch (e) {}
                        try { currentVtkPipeline.actor && currentVtkPipeline.actor.delete && currentVtkPipeline.actor.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderer && currentVtkPipeline.renderer.delete && currentVtkPipeline.renderer.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderWindow && currentVtkPipeline.renderWindow.delete && currentVtkPipeline.renderWindow.delete(); } catch (e) {}
                        currentVtkPipeline = null;
                    }
                } catch (e) {}
                container.innerHTML = '';
                container.style.position = 'relative';
                container.style.overflow = 'hidden';
                container.style.background = '#000';
                try {
                    const rect = container.getBoundingClientRect();
                    if (!rect || rect.height < 10) {
                        container.style.minHeight = '220px';
                    }
                } catch (e) {}
                // Ensure required vtk namespaces are present
                if (!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader && vtk.Rendering && vtk.Rendering.Core && vtk.Rendering.OpenGL)) {
                    console.error('vtk missing required modules for OBJ:', {
                        Misc: !!(vtk && vtk.IO && vtk.IO.Misc), OBJ: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                        Rendering: !!(vtk && vtk.Rendering), Core: !!(vtk && vtk.Rendering && vtk.Rendering.Core), OpenGL: !!(vtk && vtk.Rendering && vtk.Rendering.OpenGL)
                    });
                    try { updateStatus('vtk.js OBJ modules missing'); } catch (e) {}
                    return;
                }
                const reader = vtk.IO.Misc.vtkOBJReader.newInstance();
                try {
                    const txt = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer));
                    reader.parseAsText(txt);
                } catch (e) {
                    console.warn('OBJ parse text failed');
                    try { updateStatus('Failed to parse OBJ'); } catch (e2) {}
                    return;
                }
                const polydata = reader.getOutputData(0);
                if (!polydata) {
                    console.warn('No geometry parsed from OBJ');
                    try { updateStatus('No geometry parsed from OBJ'); } catch (e) {}
                    return;
                }
                const mapper = vtk.Rendering.Core.vtkMapper.newInstance();
                mapper.setInputData(polydata);
                const actor = vtk.Rendering.Core.vtkActor.newInstance();
                actor.setMapper(mapper);
                // Use color from server response if available, otherwise use default
                if (color && Array.isArray(color) && color.length >= 3) {
                    try { actor.getProperty().setColor(color[0], color[1], color[2]); } catch (e) {}
                } else {
                    try { actor.getProperty().setColor(0.8, 0.9, 1.0); } catch (e) {}
                }
                let renderer = null;
                let renderWindow = null;
                let interactor = null;
                let openGLRenderWindow = null;
                let usingFallbackFSR = false;
                try {
                    renderWindow = vtk.Rendering.Core.vtkRenderWindow.newInstance();
                    renderer = vtk.Rendering.Core.vtkRenderer.newInstance();
                    try { renderer.setBackground(0, 0, 0); } catch (e) {}
                    renderWindow.addRenderer(renderer);
                    openGLRenderWindow = vtk.Rendering.OpenGL.vtkRenderWindow.newInstance();
                    openGLRenderWindow.setContainer(container);
                    renderWindow.addView(openGLRenderWindow);
                    interactor = vtk.Rendering.Core.vtkRenderWindowInteractor.newInstance();
                    interactor.setView(openGLRenderWindow);
                try { interactor.initialize(); } catch (e) {}
                try { interactor.bindEvents(container); } catch (e) {}
                try {
                    // Enable common mouse interactions: rotate (LMB), pan (MMB), zoom (RMB/wheel)
                    if (vtk && vtk.Interaction && vtk.Interaction.Style && vtk.Interaction.Style.vtkInteractorStyleTrackballCamera) {
                        const style = vtk.Interaction.Style.vtkInteractorStyleTrackballCamera.newInstance();
                        interactor.setInteractorStyle(style);
                    }
                } catch (e) {}
                    renderer.addActor(actor);
                } catch (e) {
                    try {
                        const fsr = vtk.Rendering.Misc.vtkFullScreenRenderWindow.newInstance({
                            rootContainer: container,
                            container: container,
                            background: [0, 0, 0]
                        });
                        renderer = fsr.getRenderer();
                        renderWindow = fsr.getRenderWindow();
                        renderer.addActor(actor);
                        usingFallbackFSR = true;
                    } catch (e2) {
                        updateStatus('Failed to create vtk renderer');
                        return;
                    }
                }
                function resize() {
                    try {
                        const rect2 = container.getBoundingClientRect();
                        if (!rect2) return;
                        if (openGLRenderWindow && rect2.width > 0 && rect2.height > 0) {
                            openGLRenderWindow.setSize(Math.floor(rect2.width), Math.floor(rect2.height));
                        }
                        if (renderWindow) renderWindow.render();
                    } catch (e) {}
                }
                try { renderer.resetCamera(); } catch (e) {}
                try { renderWindow && renderWindow.render(); } catch (e) {}
                resize();
                setTimeout(resize, 50);
                window.addEventListener('resize', resize);
                try {
                    // Enhance UX: prevent context menu and add dblclick to reset camera
                    container.addEventListener('contextmenu', function(ev){ try { ev.preventDefault(); } catch (e) {} });
                    container.addEventListener('dblclick', function(){
                        try { renderer.resetCamera(); renderWindow && renderWindow.render(); } catch (e) {}
                    });
                } catch (e) {}
                currentVtkPipeline = { interactor, openGLRenderWindow, renderer, renderWindow, actor, mapper, usingFallbackFSR };
                try { updateStatus('OBJ rendered in Volume Preview'); } catch (e) {}
            } catch (e) {
                console.error('renderOBJInVolume error', e);
                try { updateStatus('Failed to render OBJ'); } catch (e2) {}
            }
        }

        function retryRenderMultiOBJ(objFiles, attempts) {
            console.log('[webview] retryRenderMultiOBJ before');
            if (!objFiles || !Array.isArray(objFiles) || objFiles.length === 0) return;
            console.log('[webview] retryRenderMultiOBJ after');
            const maxAttempts = Math.max(1, attempts|0);
            let count = 0;
            const container = volumeElement;
            function tryOnce() {
                try {
                    const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
                    const hasSize = rect && rect.width > 0 && rect.height > 0;
                    const hasOBJ = !!(typeof vtk !== 'undefined' && vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader);
                    console.log('[webview] retryRenderMultiOBJ check', {
                        vtkLoaded: typeof vtk !== 'undefined',
                        vtkIO: !!(vtk && vtk.IO),
                        vtkIOMisc: !!(vtk && vtk.IO && vtk.IO.Misc),
                        vtkOBJReader: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                        hasOBJ: hasOBJ
                    });
                    if (hasOBJ && hasSize) {
                        console.log('[webview] retryRenderMultiOBJ proceeding: has vtk OBJ and container size', { w: rect && rect.width, h: rect && rect.height });
                        renderMultiOBJInVolume(objFiles);
                        return;
                    }
                } catch (e) {}
                count++;
                if (count >= maxAttempts) {
                    console.log('[webview] retryRenderMultiOBJ last attempt');
                    ensureVtkLoaded().then(function(){
                        try {
                            const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
                            const hasSize = rect && rect.width > 0 && rect.height > 0;
                            const hasOBJ = !!(typeof vtk !== 'undefined' && vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader);
                            console.log('[webview] retryRenderMultiOBJ final check', {
                                vtkLoaded: typeof vtk !== 'undefined',
                                vtkIO: !!(vtk && vtk.IO),
                                vtkIOMisc: !!(vtk && vtk.IO && vtk.IO.Misc),
                                vtkOBJReader: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                                hasOBJ: hasOBJ,
                                hasSize: hasSize
                            });
                            if (hasOBJ && hasSize) {
                                renderMultiOBJInVolume(objFiles);
                            } else {
                                console.warn('[webview] retryRenderMultiOBJ final check failed', { hasOBJ, hasSize });
                            }
                        } catch (e) {}
                    });
                    return;
                }
                setTimeout(tryOnce, 200);
            }
            tryOnce();
        }

        function retryRenderOBJ(arrayBuffer, attempts, color) {
            console.log('[webview] retryRenderOBJ before');
            if (!arrayBuffer) return;
            console.log('[webview] retryRenderOBJ after');
            const maxAttempts = Math.max(1, attempts|0);
            let count = 0;
            const container = volumeElement;
            function tryOnce() {
                try {
                    const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
                    const hasSize = rect && rect.width > 0 && rect.height > 0;
                    const hasOBJ = !!(typeof vtk !== 'undefined' && vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader);
                    console.log('[webview] VTK availability check:', {
                        vtk: typeof vtk !== 'undefined',
                        vtkIO: !!(vtk && vtk.IO),
                        vtkIOMisc: !!(vtk && vtk.IO && vtk.IO.Misc),
                        vtkOBJReader: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                        hasOBJ: hasOBJ
                    });
                    if (hasOBJ && hasSize) {
                        console.log('[webview] retryRenderOBJ proceeding: has vtk OBJ and container size', { w: rect && rect.width, h: rect && rect.height });
                        renderOBJInVolumeLegacy(arrayBuffer, color);
                        return;
                    }
                } catch (e) {}
                count++;
                if (count >= maxAttempts) {
                    console.log('[webview] retryRenderOBJ last attempt');
                    ensureVtkLoaded().then(function(){
                        try {
                            const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
                            const hasSize = rect && rect.width > 0 && rect.height > 0;
                            const hasOBJ = !!(typeof vtk !== 'undefined' && vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader);
                            console.log('[webview] VTK final check:', {
                                vtk: typeof vtk !== 'undefined',
                                vtkIO: !!(vtk && vtk.IO),
                                vtkIOMisc: !!(vtk && vtk.IO && vtk.IO.Misc),
                                vtkOBJReader: !!(vtk && vtk.IO && vtk.IO.Misc && vtk.IO.Misc.vtkOBJReader),
                                hasOBJ: hasOBJ,
                                hasSize: hasSize
                            });
                            if (hasOBJ && hasSize) {
                                renderOBJInVolumeLegacy(arrayBuffer, color);
                            } else {
                                console.warn('[webview] retryRenderOBJ final check failed', { hasOBJ, hasSize });
                            }
                        } catch (e) {}
                    });
                    return;
                }
                pendingVtkRetryTimer = setTimeout(function(){ ensureVtkLoaded().then(function(){ tryOnce(); }); }, 200 + count * 150);
            }
            ensureVtkLoaded().then(function(){ tryOnce(); });
        }
        function renderVTPInVolume(arrayBuffer) {
            try {
                const container = volumeElement;
                if (!container || typeof vtk === 'undefined') {
                    console.warn('vtk.js not available or container missing');
                    try { updateStatus('vtk.js not ready or container missing'); } catch (e) {}
                    return;
                }
                // Clear previous content and dispose previous renderer
                try {
                    if (currentVtkPipeline) {
                        try { currentVtkPipeline.interactor && currentVtkPipeline.interactor.delete && currentVtkPipeline.interactor.delete(); } catch (e) {}
                        try { currentVtkPipeline.openGLRenderWindow && currentVtkPipeline.openGLRenderWindow.delete && currentVtkPipeline.openGLRenderWindow.delete(); } catch (e) {}
                        try { currentVtkPipeline.mapper && currentVtkPipeline.mapper.delete && currentVtkPipeline.mapper.delete(); } catch (e) {}
                        try { currentVtkPipeline.actor && currentVtkPipeline.actor.delete && currentVtkPipeline.actor.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderer && currentVtkPipeline.renderer.delete && currentVtkPipeline.renderer.delete(); } catch (e) {}
                        try { currentVtkPipeline.renderWindow && currentVtkPipeline.renderWindow.delete && currentVtkPipeline.renderWindow.delete(); } catch (e) {}
                        currentVtkPipeline = null;
                    }
                } catch (e) {}
                container.innerHTML = '';
                container.style.position = 'relative';
                container.style.overflow = 'hidden';
                container.style.background = '#000';
                // Ensure container has some height if layout not settled yet
                try {
                    const rect = container.getBoundingClientRect();
                    if (!rect || rect.height < 10) {
                        container.style.minHeight = '220px';
                    }
                } catch (e) {}
                // VTP is XML; prefer parsing from string
                // Ensure required vtk namespaces are present
                if (!(vtk && vtk.IO && vtk.IO.XML && vtk.IO.XML.vtkXMLPolyDataReader && vtk.Rendering && vtk.Rendering.Core && vtk.Rendering.OpenGL)) {
                    console.error('vtk missing required modules:', {
                        IO: !!(vtk && vtk.IO), XML: !!(vtk && vtk.IO && vtk.IO.XML),
                        Reader: !!(vtk && vtk.IO && vtk.IO.XML && vtk.IO.XML.vtkXMLPolyDataReader),
                        Rendering: !!(vtk && vtk.Rendering), Core: !!(vtk && vtk.Rendering && vtk.Rendering.Core), OpenGL: !!(vtk && vtk.Rendering && vtk.Rendering.OpenGL)
                    });
                    try { updateStatus('vtk.js modules missing'); } catch (e) {}
                    return;
                }
                const reader = vtk.IO.XML.vtkXMLPolyDataReader.newInstance();
                try {
                    const txt = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer));
                    reader.parseAsString(txt);
                } catch (e) {
                    // Fallback to ArrayBuffer parsing
                    console.warn('parseAsString failed, using parseAsArrayBuffer');
                    reader.parseAsArrayBuffer(arrayBuffer);
                }
                const polydata = reader.getOutputData(0);
                if (!polydata) {
                    console.warn('No polydata parsed from VTP');
                    try { updateStatus('No polydata parsed from VTP'); } catch (e) {}
                    return;
                }
                try {
                    const pts = polydata.getPoints && polydata.getPoints();
                    const npts = pts && pts.getNumberOfPoints ? pts.getNumberOfPoints() : 0;
                    console.log('[webview] polydata points:', npts);
                    if (!npts || npts <= 0) {
                        try { updateStatus('Empty VTP geometry'); } catch (e) {}
                    }
                } catch (e) {}
                const mapper = vtk.Rendering.Core.vtkMapper.newInstance();
                mapper.setInputData(polydata);
                const actor = vtk.Rendering.Core.vtkActor.newInstance();
                actor.setMapper(mapper);
                try { actor.getProperty().setColor(1, 0.8, 0.2); } catch (e) {}

                let renderer = null;
                let renderWindow = null;
                let interactor = null;
                let openGLRenderWindow = null;
                let usingFallbackFSR = false;
                try {
                    renderWindow = vtk.Rendering.Core.vtkRenderWindow.newInstance();
                    renderer = vtk.Rendering.Core.vtkRenderer.newInstance();
                    try { renderer.setBackground(0, 0, 0); } catch (e) {}
                    renderWindow.addRenderer(renderer);
                    openGLRenderWindow = vtk.Rendering.OpenGL.vtkRenderWindow.newInstance();
                    openGLRenderWindow.setContainer(container);
                    renderWindow.addView(openGLRenderWindow);
                    interactor = vtk.Rendering.Core.vtkRenderWindowInteractor.newInstance();
                    interactor.setView(openGLRenderWindow);
                try { interactor.initialize(); } catch (e) {}
                try { interactor.bindEvents(container); } catch (e) {}
                try {
                    if (vtk && vtk.Interaction && vtk.Interaction.Style && vtk.Interaction.Style.vtkInteractorStyleTrackballCamera) {
                        const style = vtk.Interaction.Style.vtkInteractorStyleTrackballCamera.newInstance();
                        interactor.setInteractorStyle(style);
                    }
                } catch (e) {}
                    renderer.addActor(actor);
                } catch (e) {
                    try {
                        // Fallback: FullScreenRenderWindow
                        const fsr = vtk.Rendering.Misc.vtkFullScreenRenderWindow.newInstance({
                            rootContainer: container,
                            container: container,
                            background: [0, 0, 0]
                        });
                        renderer = fsr.getRenderer();
                        renderWindow = fsr.getRenderWindow();
                        renderer.addActor(actor);
                        usingFallbackFSR = true;
                    } catch (e2) {
                        updateStatus('Failed to create vtk renderer');
                        return;
                    }
                }

                function resize() {
                    try {
                        const rect2 = container.getBoundingClientRect();
                        if (!rect2) return;
                        if (openGLRenderWindow && rect2.width > 0 && rect2.height > 0) {
                            openGLRenderWindow.setSize(Math.floor(rect2.width), Math.floor(rect2.height));
                        }
                        if (renderWindow) renderWindow.render();
                    } catch (e) {}
                }
                // Initial render and resize schedule
                try { renderer.resetCamera(); } catch (e) {}
                try { renderWindow && renderWindow.render(); } catch (e) {}
                resize();
                setTimeout(resize, 50);
                window.addEventListener('resize', resize);
                try {
                    container.addEventListener('contextmenu', function(ev){ try { ev.preventDefault(); } catch (e) {} });
                    container.addEventListener('dblclick', function(){
                        try { renderer.resetCamera(); renderWindow && renderWindow.render(); } catch (e) {}
                    });
                } catch (e) {}

                currentVtkPipeline = { interactor, openGLRenderWindow, renderer, renderWindow, actor, mapper, usingFallbackFSR };
                try { updateStatus('VTP rendered in Volume Preview'); } catch (e) {}
            } catch (e) {
                console.error('renderVTPInVolume error', e);
                try { updateStatus('Failed to render VTP'); } catch (e2) {}
            }
        }

        function retryRenderVTP(arrayBuffer, attempts) {
            if (!arrayBuffer) return;
            lastVtpArrayBuffer = arrayBuffer;
            const maxAttempts = Math.max(1, attempts|0);
            let count = 0;
            const container = volumeElement;
            function tryOnce() {
                try {
                    const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
                    const hasSize = rect && rect.width > 0 && rect.height > 0;
                    if (typeof vtk !== 'undefined' && hasSize) {
                        console.log('[webview] retryRenderVTP proceeding: has vtk and container size', { w: rect && rect.width, h: rect && rect.height });
                        renderVTPInVolume(arrayBuffer);
                        return;
                    }
                } catch (e) {}
                count++;
                if (count >= maxAttempts) {
                    console.log('[webview] retryRenderVTP last attempt');
                    ensureVtkLoaded().then(function(){
                        try {
                            const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
                            const hasSize = rect && rect.width > 0 && rect.height > 0;
                            const hasVTK = (typeof vtk !== 'undefined');
                            if (hasVTK && hasSize) {
                                renderVTPInVolume(arrayBuffer);
                            } else {
                                console.warn('[webview] retryRenderVTP final check failed', { hasVTK, hasSize });
                            }
                        } catch (e) {}
                    });
                    return;
                }
                pendingVtkRetryTimer = setTimeout(function(){ ensureVtkLoaded().then(function(){ tryOnce(); }); }, 200 + count * 150);
            }
            ensureVtkLoaded().then(function(){ tryOnce(); });
        }

        // Draw NIfTI planes to dedicated views (axial/sagittal/coronal)
        function displayNiftiData(response) {
            try {
                function shapesEqual(a, b) {
                    if (!a || !b) return false;
                    if (!Array.isArray(a) || !Array.isArray(b)) return false;
                    if (a.length !== b.length) return false;
                    for (let i = 0; i < a.length; i++) { if (Number(a[i]) !== Number(b[i])) return false; }
                    return true;
                }
                const planeMap = { axial: axialElement, sagittal: sagittalElement, coronal: coronalElement };
                if (response.axial || response.sagittal || response.coronal) {
                    // multi-plane base images
                    if (response.axial) baseCache.axial = { pixelData: response.axial.pixelData || response.axial.content, rows: response.axial.rows, columns: response.axial.columns };
                    if (response.sagittal) baseCache.sagittal = { pixelData: response.sagittal.pixelData || response.sagittal.content, rows: response.sagittal.rows, columns: response.sagittal.columns };
                    if (response.coronal) baseCache.coronal = { pixelData: response.coronal.pixelData || response.coronal.content, rows: response.coronal.rows, columns: response.coronal.columns };
                    try {
                        if (response && response.metadata && Array.isArray(response.metadata.shape)) {
                            baseVolumeShape = response.metadata.shape.slice();
                        }
                    } catch (e) {}
                    drawComposite('axial', axialElement);
                    drawComposite('sagittal', sagittalElement);
                    drawComposite('coronal', coronalElement);
                // Do not draw 2D slices into 3D view panel
                    if (seriesInfo && response.metadata) {
                        seriesInfo.textContent = 'NIfTI Image - Dimensions: ' + (response.metadata.shape || '');
                    }
                    updateStatus('NIfTI planes displayed');
                    try { vscode.postMessage({ type: 'log', level: 'log', text: 'NIfTI planes displayed' }); } catch {}
                    return;
                }
                const plane = (response && response.plane) ? String(response.plane).toLowerCase() : '';
                const payloadPixel = response.pixelData || response.content;
                if (!payloadPixel) return;
                if (response.isSeg) {
                    // Validate seg volume shape matches base shape, if both present
                    try {
                        const segShape = response && response.metadata && Array.isArray(response.metadata.shape) ? response.metadata.shape : null;
                        if (baseVolumeShape && segShape && !shapesEqual(baseVolumeShape, segShape)) {
                            const msg = 'Segmentation shape mismatch: base ' + JSON.stringify(baseVolumeShape) + ' vs seg ' + JSON.stringify(segShape);
                            updateStatus(msg);
                            try { vscode.postMessage({ type: 'showError', text: msg }); } catch (e) {}
                            return;
                        }
                    } catch (e) {}
                    // update seg cache and redraw
                    if (plane && segCache.hasOwnProperty(plane)) {
                        segCache[plane] = { pixelData: payloadPixel };
                        drawComposite(plane, planeMap[plane]);
                        // Do not draw 2D slices into 3D view panel
                    }
                } else {
                    if (plane && baseCache.hasOwnProperty(plane)) {
                        baseCache[plane] = { pixelData: payloadPixel, rows: response.rows, columns: response.columns };
                        try {
                            if (response && response.metadata && Array.isArray(response.metadata.shape)) {
                                baseVolumeShape = response.metadata.shape.slice();
                            }
                        } catch (e) {}
                        drawComposite(plane, planeMap[plane]);
                        // Do not draw 2D slices into 3D view panel
                    } else {
                        // Unknown plane: attempt to draw all
                        ['axial','sagittal','coronal'].forEach(function(p){ if (baseCache[p]) drawComposite(p, planeMap[p]); });
                    }
                }
                if (seriesInfo && response.metadata) {
                    seriesInfo.textContent = 'NIfTI Image - Dimensions: ' + (response.metadata.shape || '');
                }
                updateStatus('NIfTI slice displayed');
                try { vscode.postMessage({ type: 'log', level: 'log', text: 'NIfTI displayed (single plane)' }); } catch {}
            } catch (err) {
                console.error('[webview] Error displaying NIfTI data:', err);
                updateStatus('Error displaying NIfTI data: ' + err.message);
                try { vscode.postMessage({ type: 'log', level: 'error', text: 'displayNiftiData error: ' + (err && err.message ? err.message : String(err)) }); } catch {}
            }
        }
        
        // Implement MPR reconstruction
        function initializeMPR() {
            if (!loadedSeries || loadedSeries.length === 0) {
                return;
            }
            
            // Simplified MPR implementation
            // Display middle slice to sagittal and coronal views
            const middleIndex = Math.floor(loadedSeries.length / 2);
            
            // For a real MPR implementation, we would need to:
            // 1. Build a 3D volume from all DICOM slices
            // 2. Implement multi-planar reconstruction algorithms
            // 3. Support linked navigation between the planes
            
            // For now, we'll display the same image in axial/sagittal/coronal only (3D view is reserved for VTP)
            cornerstone.displayImage(sagittalElement, loadedSeries[middleIndex]);
            cornerstone.displayImage(coronalElement, loadedSeries[middleIndex]);
            
            // Set stack for navigation
            const stack = {
                currentImageIdIndex: middleIndex,
                imageIds: loadedSeries.map((_, index) => 'vscode-dicom://' + index)
            };
            
            cornerstoneTools.addToolState(sagittalElement, 'stack', stack);
            cornerstoneTools.addToolState(coronalElement, 'stack', stack);
            // Do not set stack state for 3D View panel
            
            // Update view information
            updateViewInfo('axial-info', 'Slice ' + (0 + 1) + '/' + loadedSeries.length);
            updateViewInfo('sagittal-info', 'Slice ' + (middleIndex + 1) + '/' + loadedSeries.length);
            updateViewInfo('coronal-info', 'Slice ' + (middleIndex + 1) + '/' + loadedSeries.length);
            updateViewInfo('volume-info', '3D View');
            
            // Set up stack scroll tool for slice navigation
            cornerstoneTools.addToolForElement(axialElement, cornerstoneTools.StackScrollTool);
            cornerstoneTools.addToolForElement(sagittalElement, cornerstoneTools.StackScrollTool);
            cornerstoneTools.addToolForElement(coronalElement, cornerstoneTools.StackScrollTool);
            // Do not attach stack scroll tool to 3D View panel
        }
        
        // Initial status
        updateStatus('Ready');
    </script>
</body>
</html>`;
}

// 生成随机nonce以允许内联脚本
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    
    return text;
}

export function deactivate() {
    panel = undefined;
    try { if (niftiServerProc) { niftiServerProc.kill(); } } catch {}
    niftiServerProc = undefined;
    niftiServerPort = undefined;
}
