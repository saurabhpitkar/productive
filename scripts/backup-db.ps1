$BackupRoot = "D:\productive-backup"
$MaxBackups = 10
$Container  = "productive-backend-v2-1"
$DbDir      = "/data/users"
$Timestamp  = Get-Date -Format "yyyy-MM-dd_HH-mm"
$BackupDir  = Join-Path $BackupRoot $Timestamp
$LogFile    = Join-Path $BackupRoot "backup.log"

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# Ensure backup root exists
if (-not (Test-Path $BackupRoot)) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
}

Write-Log "Starting backup to $BackupDir"

# Check the container is running
$running = docker inspect --format '{{.State.Running}}' $Container 2>$null
if ($running -ne 'true') {
    Write-Log "ERROR: Container '$Container' is not running. Aborting."
    exit 1
}

# Copy the entire /data/users directory out of the container
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
docker cp "${Container}:${DbDir}" $BackupDir
if (-not $?) {
    Write-Log "ERROR: docker cp failed."
    Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# Count and size the backed-up files
$files   = Get-ChildItem -Path $BackupDir -Recurse -File
$sizeMB  = [math]::Round(($files | Measure-Object -Property Length -Sum).Sum / 1MB, 2)
$dbCount = ($files | Where-Object { $_.Extension -eq '.db' }).Count
Write-Log "Backup OK - $dbCount user DB(s), ${sizeMB} MB total"

# Prune: keep only the $MaxBackups most recent backup directories
$allDirs = Get-ChildItem -Path $BackupRoot -Directory |
           Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$' } |
           Sort-Object LastWriteTime -Descending

if ($allDirs.Count -gt $MaxBackups) {
    $toDelete = $allDirs | Select-Object -Skip $MaxBackups
    foreach ($d in $toDelete) {
        Remove-Item $d.FullName -Recurse -Force
        Write-Log "Pruned old backup: $($d.Name)"
    }
}

$retained = [math]::Min($allDirs.Count, $MaxBackups)
Write-Log "Done. $retained backup(s) retained."
