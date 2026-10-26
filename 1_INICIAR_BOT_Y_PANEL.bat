@echo off
title CRM AI Bot - WhatsApp & Panel de Control
chcp 65001 >nul
cd /d "%~dp0"

echo =====================================================================
echo           🤖 CRM AI BOT WHATSAPP • STARTER
echo =====================================================================
echo.
echo Iniciando servidor y bot de WhatsApp...
echo Abriendo Centro de Control en http://localhost:3090...
echo (Presione Ctrl + C para detener)
echo.

rem Cerrar instancias previas de túnel si existieran
taskkill /F /IM cloudflared.exe >nul 2>nul

rem Abrir el navegador automáticamente en 4 segundos
start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3090"

rem Ejecutar con node
if exist "node.exe" (
    node.exe index.js
) else (
    node index.js
)

pause
