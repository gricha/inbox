@echo off
rem Windows twin of bin/desk.
set "entry=%~dp0..\src\cli.ts"
if not exist "%entry%" set "entry=%~dp0..\lib\cli.js"
node --disable-warning=ExperimentalWarning "%entry%" %*
