@echo off
setlocal
cd /d "%~dp0"

rem A future portable release can place a self-contained Python runtime here.
if exist "runtime\python\python.exe" (
  "runtime\python\python.exe" -m h3_standalone %*
  goto :done
)

if not exist ".venv\Scripts\python.exe" (
  echo Preparing H3 Prompt Writer for the first launch...
  where uv >nul 2>nul
  if not errorlevel 1 (
    uv venv ".venv" || goto :setup_failed
    uv pip install --python ".venv\Scripts\python.exe" -r requirements.txt || goto :setup_failed
  ) else (
    where py >nul 2>nul
    if not errorlevel 1 (
      py -3 -m venv ".venv" || goto :python_missing
    ) else (
      where python >nul 2>nul || goto :python_missing
      python -m venv ".venv" || goto :python_missing
    )
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :setup_failed
  )
)

".venv\Scripts\python.exe" -m h3_standalone %*
goto :done

:python_missing
echo.
echo Python 3.10 or newer was not found.
echo Install Python once, or use a release that includes runtime\python.
goto :failed

:setup_failed
echo.
echo The local environment could not be prepared.
goto :failed

:failed
pause
exit /b 1

:done
endlocal
