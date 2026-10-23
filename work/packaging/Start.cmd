@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Team Studio
"%~dp0runtime\node.exe" "%~dp0launcher.cjs" start
if errorlevel 1 pause
