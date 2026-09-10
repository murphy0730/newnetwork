@echo off
rem ======================================================================
rem  启动供应网络控制塔服务（对应 end.cmd）
rem
rem  用法：
rem    start.cmd           -> 端口 8787
rem    start.cmd 9000      -> 端口 9000（停止时也要用 end.cmd 9000）
rem
rem  维护注意：本文件必须以 CRLF 换行保存（.gitattributes 已强制 *.cmd eol=crlf）
rem ======================================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>&1

set "PORT=%~1"
if not defined PORT set "PORT=8787"

rem --- 启动前先查端口, 避免 node 抛 EADDRINUSE 后窗口一闪而过 ---
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if errorlevel 1 (echo [start] 启动控制塔: http://127.0.0.1:%PORT%/) else (echo [start] 端口 %PORT% 已被占用, 请先执行 end.cmd %PORT%)
if not errorlevel 1 (pause & exit /b 1)

rem --- 把端口透传给 node（server/main.js 读取 process.env.PORT）---
set PORT=%PORT%
node server/main.js

pause
