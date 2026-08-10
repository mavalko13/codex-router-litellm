@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-router.ps1" %*
exit /b %ERRORLEVEL%
