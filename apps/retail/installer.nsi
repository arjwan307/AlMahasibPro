!ifndef PROJECT_DIR
!define PROJECT_DIR "${__FILEDIR__}/../.."
!endif
!ifndef VERSION
!define VERSION "1.0.0"
!endif
OutFile "${PROJECT_DIR}/releases/retail/AlMahasibPro-Retail-Setup-${VERSION}-x64.exe"
!include "MUI2.nsh"
!include "FileFunc.nsh"
Name "AlMahasibPro-Retail"
InstallDir "$LOCALAPPDATA\Programs\AlMahasibPro-Retail"
InstallDirRegKey HKCU "Software\AlMahasibPro-Retail" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID zlib
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\AlMahasibPro-Retail.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Arabic"
!insertmacro MUI_LANGUAGE "English"
Function .onVerifyInstDir
 ${GetFileName} "$INSTDIR" $0
 StrCmp $0 "AlMahasibPro-Retail" valid
 Abort
 valid:
FunctionEnd
Section "AlMahasibPro-Retail" SEC01
 SetOutPath "$INSTDIR"
 File /r "${PROJECT_DIR}/releases/retail/win-unpacked/*"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 CreateDirectory "$SMPROGRAMS\AlMahasibPro-Retail"
 CreateShortcut "$SMPROGRAMS\AlMahasibPro-Retail\AlMahasibPro-Retail.lnk" "$INSTDIR\AlMahasibPro-Retail.exe"
 CreateShortcut "$DESKTOP\AlMahasibPro-Retail.lnk" "$INSTDIR\AlMahasibPro-Retail.exe"
 WriteRegStr HKCU "Software\AlMahasibPro-Retail" "InstallDir" "$INSTDIR"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Retail" "DisplayName" "AlMahasibPro-Retail"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Retail" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Retail" "DisplayVersion" "${VERSION}"
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Retail" "NoModify" 1
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Retail" "NoRepair" 1
SectionEnd
Section "Uninstall"
 Delete "$DESKTOP\AlMahasibPro-Retail.lnk"
 RMDir /r "$SMPROGRAMS\AlMahasibPro-Retail"
 RMDir /r "$INSTDIR"
 DeleteRegKey HKCU "Software\AlMahasibPro-Retail"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Retail"
 ; Deliberately retain company data under the user's AppData.
SectionEnd
