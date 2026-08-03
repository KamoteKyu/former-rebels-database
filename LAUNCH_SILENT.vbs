Dim appDir
appDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

Dim electronExe
electronExe = appDir & "node_modules\electron\dist\electron.exe"

Dim oShell
Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = appDir
oShell.Run """" & electronExe & """ .""", 0, False
