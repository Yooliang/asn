@echo off
rem Irori relay bridge installer - double click to run (extract the zip first).
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
