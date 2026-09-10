@echo off
chcp 65001 >nul
setlocal
rem 停止供应网络控制塔服务（对应 start.cmd，默认端口 8787；可用 end.cmd 端口号 指定其他端口）
set PORT=8787
if not "%~1"=="" set PORT=%~1
set FOUND=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do call :kill %%a
if not defined FOUND echo 未在端口 %PORT% 发现运行中的控制塔服务
pause
goto :eof

:kill
set FOUND=1
tasklist /FI "PID eq %1" /FO CSV /NH | findstr /I "node.exe" >nul
if errorlevel 1 goto :skip
taskkill /PID %1 /F >nul 2>&1
if errorlevel 1 (echo 停止 PID %1 失败，请尝试用管理员身份运行) else echo 已停止控制塔服务，PID %1
goto :eof
:skip
echo PID %1 不是 node 进程，已跳过
goto :eof
