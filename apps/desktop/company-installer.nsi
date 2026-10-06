!ifndef PROJECT_DIR
!define PROJECT_DIR "${__FILEDIR__}/../.."
!endif
!ifndef VERSION
!define VERSION "1.0.0"
!endif
OutFile "${PROJECT_DIR}/releases/companies/AlMahasibPro-Companies-Setup-${VERSION}-x64.exe"
!include "MUI2.nsh"
!include "FileFunc.nsh"
Name "AlMahasibPro-Companies"
InstallDir "$LOCALAPPDATA\Programs\AlMahasibPro-Companies"
InstallDirRegKey HKCU "Software\AlMahasibPro-Companies" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID zlib
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\AlMahasibPro-Companies.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Arabic"
!insertmacro MUI_LANGUAGE "English"
Function .onVerifyInstDir
 ${GetFileName} "$INSTDIR" $0
 StrCmp $0 "AlMahasibPro-Companies" valid
 Abort
 valid:
FunctionEnd
Section "AlMahasibPro-Companies" SEC01
 SetOutPath "$INSTDIR"
 File /r "${PROJECT_DIR}/releases/companies/win-unpacked/*"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 CreateDirectory "$SMPROGRAMS\AlMahasibPro-Companies"
 CreateShortcut "$SMPROGRAMS\AlMahasibPro-Companies\AlMahasibPro-Companies.lnk" "$INSTDIR\AlMahasibPro-Companies.exe"
 CreateShortcut "$DESKTOP\AlMahasibPro-Companies.lnk" "$INSTDIR\AlMahasibPro-Companies.exe"
 WriteRegStr HKCU "Software\AlMahasibPro-Companies" "InstallDir" "$INSTDIR"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Companies" "DisplayName" "AlMahasibPro-Companies"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Companies" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Companies" "DisplayVersion" "${VERSION}"
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Companies" "NoModify" 1
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Companies" "NoRepair" 1
SectionEnd
Section "Uninstall"
 Delete "$DESKTOP\AlMahasibPro-Companies.lnk"
 RMDir /r "$SMPROGRAMS\AlMahasibPro-Companies"
 RMDir /r "$INSTDIR"
 DeleteRegKey HKCU "Software\AlMahasibPro-Companies"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlMahasibPro-Companies"
 ; Deliberately retain company data under the user's AppData.
SectionEnd
