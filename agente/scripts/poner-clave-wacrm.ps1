# poner-clave-wacrm.ps1 — Escribe una clave secreta en el .env
#
# La clave se teclea aquí, en tu consola, y va directo al archivo: no pasa
# por ningún chat ni queda en el historial de PowerShell (Read-Host
# -AsSecureString no lo registra).
#
# Uso:   .\scripts\poner-clave-wacrm.ps1                    (la del CRM)
#        .\scripts\poner-clave-wacrm.ps1 ANTHROPIC_API_KEY  (otra cualquiera)

param(
    [string]$Variable = 'WACRM_API_KEY'
)

$ErrorActionPreference = 'Stop'

# Prefijo esperado por variable, para atajar una clave mal pegada aquí en
# vez de que falle luego con un 401 difícil de relacionar con este momento.
$prefijos = @{
    'WACRM_API_KEY'     = 'wacrm_live_'
    'ANTHROPIC_API_KEY' = 'sk-ant-'
}
$prefijo = $prefijos[$Variable]

$env_path = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (-not (Test-Path $env_path)) {
    Write-Host "No encuentro el archivo: $env_path" -ForegroundColor Red
    exit 1
}

Write-Host ""
$pista = if ($prefijo) { " (empieza con $prefijo)" } else { "" }
Write-Host "Pega el valor de $Variable$pista." -ForegroundColor Cyan
Write-Host "No se va a ver mientras la pegas. Eso es normal." -ForegroundColor DarkGray
$secure = Read-Host "Clave" -AsSecureString

$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $clave = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim()
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($clave)) {
    Write-Host "No escribiste nada. El archivo queda igual." -ForegroundColor Yellow
    exit 1
}
if ($prefijo -and (-not $clave.StartsWith($prefijo))) {
    Write-Host "Eso no parece un valor de $Variable (deberia empezar con '$prefijo')." -ForegroundColor Red
    Write-Host "No se modifico nada." -ForegroundColor Red
    exit 1
}

# Respaldo antes de tocar el archivo. El patrón .env.* ya está en
# .gitignore, así que este respaldo no es rastreable por git.
$respaldo = "$env_path.bak"
Copy-Item $env_path $respaldo -Force

$lineas = [System.IO.File]::ReadAllLines($env_path)
$encontrada = $false
for ($i = 0; $i -lt $lineas.Length; $i++) {
    if ($lineas[$i] -match "^\s*$([regex]::Escape($Variable))\s*=") {
        $lineas[$i] = "$Variable=$clave"
        $encontrada = $true
        break
    }
}
if (-not $encontrada) {
    $lineas += "$Variable=$clave"
}

# Sin BOM: python-dotenv lee el archivo tal cual, y un BOM al inicio se
# pegaría al nombre de la primera variable.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($env_path, $lineas, $utf8)

Write-Host ""
Write-Host "Listo. $Variable quedo en el .env." -ForegroundColor Green
Write-Host "  Longitud guardada: $($clave.Length) caracteres" -ForegroundColor DarkGray
Write-Host "  Respaldo anterior: $respaldo" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Reinicia Claudia para que tome el valor nuevo." -ForegroundColor Cyan
Write-Host ""
