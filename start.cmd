@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
rem Keep this file UTF-8 without BOM, with CRLF line endings.
rem Usage: start.cmd [port], default 8787. Stop with end.cmd [port].

where node >nul 2>&1
if errorlevel 1 goto missing_node

node server/start.js "%~1"
set "TOWER_START_EXIT=%errorlevel%"
if not "%TOWER_START_EXIT%"=="0" echo [start] 启动失败，请查看上方错误信息。
if not defined TOWER_NO_PAUSE pause
exit /b %TOWER_START_EXIT%

:missing_node
echo [start] 未找到 Node.js。请安装 Node.js 24 或更高版本，再重新打开本窗口。
if not defined TOWER_NO_PAUSE pause
exit /b 1
