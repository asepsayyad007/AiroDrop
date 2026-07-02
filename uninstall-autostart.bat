@echo off
:: uninstall-autostart.bat
:: Removes the auto-start scheduled task for the AirDrop-to-PC server.

set TASK_NAME="AirDropToPC"

schtasks /delete /tn %TASK_NAME% /f >nul 2>&1

if %ERRORLEVEL% EQU 0 (
    echo.
    echo  [SUCCESS] Auto-start removed. The server will no longer start on boot.
    echo.
) else (
    echo.
    echo  [INFO] No auto-start task found. Nothing to remove.
    echo.
)

:: Clean up the VBS wrapper
if exist "%~dp0start-hidden.vbs" del "%~dp0start-hidden.vbs"

pause