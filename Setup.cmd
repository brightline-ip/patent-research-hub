@echo off
setlocal
rem Patent Research Hub - double-click to install or repair. No administrator rights needed.
rem Windows PowerShell must not inherit PowerShell 7's module path.
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\setup.ps1" %*
set "PRH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PRH_EXIT%
