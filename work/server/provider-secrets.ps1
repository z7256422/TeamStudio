param([ValidateSet('protect', 'unprotect')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$secretBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
if ($Action -eq 'protect') {
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($secretBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $protectedBytes = [Security.Cryptography.ProtectedData]::Unprotect($secretBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
