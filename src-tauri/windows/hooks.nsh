; DataRefine Studio NSIS hooks.
;
; WebView2 is handled by Tauri's official downloadBootstrapper mode in
; tauri.conf.json. No third-party executable is downloaded here.
; Tauri's stock NSIS template also owns its normal finish-page shortcuts,
; uninstall flow, and upgrade handling.

!include LogicLib.nsh
!include StrFunc.nsh
${StrStr}
${UnStrStr}

!macro DR_CHECK_RUNNING
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH'
  Pop $0
  Pop $1
  ${StrStr} $2 $1 "${MAINBINARYNAME}.exe"
  ${If} $2 != ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "DataRefine Studio is currently running.$\r$\n$\r$\nPlease close DataRefine Studio before continuing the installer."
    Abort
  ${EndIf}

  ; Also protect the standalone engine if the desktop process exited while
  ; the local sidecar was still shutting down.
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq datarefine-engine.exe" /NH'
  Pop $0
  Pop $1
  ${StrStr} $2 $1 "datarefine-engine.exe"
  ${If} $2 != ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "The DataRefine engine is still running.$\r$\n$\r$\nPlease close DataRefine Studio and retry the installer."
    Abort
  ${EndIf}
!macroend

!macro DR_CHECK_RUNNING_UN
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH'
  Pop $0
  Pop $1
  ${UnStrStr} $2 $1 "${MAINBINARYNAME}.exe"
  ${If} $2 != ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "DataRefine Studio is currently running.$\r$\n$\r$\nPlease close DataRefine Studio before continuing the uninstaller."
    Abort
  ${EndIf}

  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq datarefine-engine.exe" /NH'
  Pop $0
  Pop $1
  ${UnStrStr} $2 $1 "datarefine-engine.exe"
  ${If} $2 != ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "The DataRefine engine is still running.$\r$\n$\r$\nPlease close DataRefine Studio and retry the uninstaller."
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Checking whether DataRefine Studio is running..."
  !insertmacro DR_CHECK_RUNNING
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Checking whether DataRefine Studio is running..."
  !insertmacro DR_CHECK_RUNNING_UN
!macroend
