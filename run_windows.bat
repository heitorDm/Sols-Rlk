@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =============================================
echo   SOL'S RNG - DARK FANTASY
echo   Servidor local com contas e coop online
echo =============================================
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m venv .venv 2>nul
) else (
  python -m venv .venv 2>nul
)
if not exist ".venv\Scripts\python.exe" (
  echo ERRO: Python nao foi encontrado. Instale Python 3.11 ou mais recente.
  pause
  exit /b 1
)
call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo ERRO: Nao foi possivel instalar as dependencias.
  pause
  exit /b 1
)
echo.
echo Abra no navegador: http://127.0.0.1:5000
echo Para outras pessoas na mesma rede: http://IP-DESTE-PC:5000
echo Para amigos fora da sua rede, publique este projeto em um servidor online.
echo Deixe esta janela aberta enquanto estiver jogando.
echo.
python app.py
pause
