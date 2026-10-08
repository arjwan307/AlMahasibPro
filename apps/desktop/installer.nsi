!include "MUI2.nsh"
!include "FileFunc.nsh"
Name "AlMahasibPro"
InstallDir "$LOCALAPPDATA\Programs\AlMahasibPro"
InstallDirRegKey HKCU "Software\AlMahasibPro" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID zlib
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\AlMahasibPro.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Arabic"
!insertmacro MUI_LANGUAGE "English"
Function .onVerifyInstDir
 ${GetFileName} "$INSTDIR" $0
 StrCmp $0 "AlMahasibPro" valid
 Abort
 valid:
FunctionEnd
Section "AlMahasibPro" SEC01
 SetOutPath "$INSTDIR"
 File /r "${PROJECT_DIR}/releases/windows/win-unpacked/*"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 CreateDirectory "$SMPROGRAMS\AlMahasibPro"
 CreateShortcut "$SMPROGRAMS\AlMahasibPro\AlMahasibPro.lnk" "$INSTDIR\AlMahasibPro.exe"
 CreateShortcut "$DESKTOP\AlMahasibPro.lnk" "$INSTDIR\AlMahasibPro.exe"
 WriteRegStr HKCU "Software\AlMahasibPro" "InstallDir" "$INSTDIR"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro" "DisplayName" "AlMahasibPro"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro" "DisplayVersion" "${VERSION}"
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro" "NoModify" 1
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro" "NoRepair" 1
SectionEnd
Section "Uninstall"
 Delete "$DESKTOP\AlMahasibPro.lnk"
 RMDir /r "$SMPROGRAMS\AlMahasibPro"
 RMDir /r "$INSTDIR"
 DeleteRegKey HKCU "Software\AlMahasibPro"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro"
 ; Deliberately retain company data under the user's AppData.
SectionEnd
