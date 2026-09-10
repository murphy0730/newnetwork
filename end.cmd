@echo off
rem ======================================================================
rem  停止供应网络控制塔服务（对应 start.cmd）
rem
rem  用法：
rem    end.cmd            -> 停止默认端口 8787 上的服务
rem    end.cmd 9000       -> 停止指定端口 9000 上的服务
rem
rem  维护注意（重要）：
rem    1. 本文件必须以 CRLF 换行保存。仓库 .gitattributes 已强制 *.cmd eol=crlf。
rem       若变成 LF，旧版 cmd.exe 执行 call/goto 会报"找不到批处理标签"并静默中止。
rem    2. 本文件为 UTF-8 无 BOM 编码，靠下面的 chcp 65001 正确显示中文。
rem       如果控制台字体不支持，只会提示乱码，不影响停止逻辑。
rem ======================================================================
setlocal DisableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1

set "PORT=%~1"
if not defined PORT set "PORT=8787"
echo [end] 目标端口: %PORT%

rem --- 第一道检查: 这个端口上到底有没有 LISTENING 的连接 ---
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if errorlevel 1 echo [end] 端口 %PORT% 上没有监听中的服务。若启动时设置过 PORT 环境变量, 请改用: end.cmd 实际端口号
if errorlevel 1 (pause & exit /b 0)

rem --- 列出占用端口的 PID, 便于人工核对 ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do echo [end] 发现监听进程 PID %%a

rem --- 只杀 node.exe, 避免误杀占用同端口的系统进程 ---
rem --- 嵌套 for 均为单行: 外层取 PID, 内层用 tasklist 校验进程名, 通过才 taskkill ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq %%a" /FO CSV /NH 2^>nul ^| findstr /I /C:"node.exe"') do taskkill /PID %%a /F 2>nul

rem --- 收尾校验: 端口是否真的释放 ---
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if errorlevel 1 (echo [end] 端口 %PORT% 已释放, 控制塔服务已停止。) else (echo [end] 端口 %PORT% 仍被占用, 请右键"以管理员身份运行"后重试。)

pause
