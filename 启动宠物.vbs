Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' autostart argument (passed by the login item): wait 8s so the desktop finishes booting. Manual launch has no argument and starts at once.
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "autostart" Then WScript.Sleep 8000
End If
WshShell.Run "cmd /c start-windows.bat", 0, False
