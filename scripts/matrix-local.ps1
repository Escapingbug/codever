param(
    [ValidateSet('start', 'bootstrap', 'status', 'stop')]
    [string]$Action = 'bootstrap'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$matrixDir = Join-Path $repoRoot 'dev\matrix'
$dataDir = Join-Path $matrixDir 'data'
$configPath = Join-Path $dataDir 'homeserver.yaml'
$outputPath = Join-Path $matrixDir 'local-test.json'
$compose = @('compose', '--project-directory', $matrixDir, '-f', (Join-Path $matrixDir 'docker-compose.yml'))

function Invoke-DockerCompose {
    & docker @compose @args
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed with exit code $LASTEXITCODE"
    }
}

function Initialize-SynapseConfig {
    if (-not (Test-Path -LiteralPath $configPath)) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        Invoke-DockerCompose run --rm synapse generate
        if (-not (Test-Path -LiteralPath $configPath)) {
            throw "Synapse did not generate $configPath"
        }
    }

    $configText = Get-Content -Raw -LiteralPath $configPath
    if ($configText -notmatch '# codever-local-test-rate-limits') {
        @'

# codever-local-test-rate-limits
# Disposable localhost fixture only. These values are unsafe for a public server.
rc_login:
  address:
    per_second: 100
    burst_count: 1000
  account:
    per_second: 100
    burst_count: 1000
  failed_attempts:
    per_second: 100
    burst_count: 1000
'@ | Add-Content -LiteralPath $configPath -Encoding utf8
    }
}

function Start-Synapse {
    Initialize-SynapseConfig
    Invoke-DockerCompose up -d synapse

    $deadline = (Get-Date).AddMinutes(2)
    do {
        try {
            $null = Invoke-RestMethod -Method Get -Uri 'http://localhost:8008/_matrix/client/versions'
            return
        } catch {
            if ((Get-Date) -ge $deadline) {
                throw 'Local Synapse did not become ready within two minutes.'
            }
            Start-Sleep -Seconds 2
        }
    } while ($true)
}

function Register-TestUser([string]$username, [string]$password) {
    $output = & docker exec codever-matrix-local register_new_matrix_user `
        http://localhost:8008 `
        -c /data/homeserver.yaml `
        --no-admin `
        -u $username `
        -p $password 2>&1
    if ($LASTEXITCODE -ne 0 -and ($output -join "`n") -notmatch 'already exists|User ID already taken') {
        throw "Could not register @$username`:localhost: $($output -join ' ')"
    }
}

function Login-TestUser(
    [string]$username,
    [string]$password,
    [string]$deviceId
) {
    $body = @{
        type = 'm.login.password'
        identifier = @{
            type = 'm.id.user'
            user = "@$username`:localhost"
        }
        password = $password
        device_id = $deviceId
        initial_device_display_name = "Codever $deviceId"
    } | ConvertTo-Json -Depth 5

    Invoke-RestMethod `
        -Method Post `
        -Uri 'http://localhost:8008/_matrix/client/v3/login' `
        -ContentType 'application/json' `
        -Body $body
}

function Invoke-MatrixPost(
    [string]$uri,
    [string]$accessToken,
    [object]$body
) {
    Invoke-RestMethod `
        -Method Post `
        -Uri $uri `
        -Headers @{ Authorization = "Bearer $accessToken" } `
        -ContentType 'application/json' `
        -Body ($body | ConvertTo-Json -Depth 10)
}

switch ($Action) {
    'start' {
        Start-Synapse
        Write-Output 'Local Matrix homeserver is ready at http://localhost:8008'
    }
    'status' {
        Invoke-DockerCompose ps
    }
    'stop' {
        Invoke-DockerCompose down
    }
    'bootstrap' {
        Start-Synapse
        if (Test-Path -LiteralPath $outputPath) {
            Write-Output "Existing test configuration: $outputPath"
            Get-Content -Raw -LiteralPath $outputPath
            break
        }

        $testerPassword = 'codever-tester-local'
        $gatewayPassword = 'codever-gateway-local'
        Register-TestUser 'tester' $testerPassword
        Register-TestUser 'gateway' $gatewayPassword

        $tester = Login-TestUser 'tester' $testerPassword 'CODEVER_PWA'
        $gateway = Login-TestUser 'gateway' $gatewayPassword 'CODEVER_GATEWAY'
        $room = Invoke-MatrixPost `
            'http://localhost:8008/_matrix/client/v3/createRoom' `
            $tester.access_token `
            @{
                visibility = 'private'
                preset = 'trusted_private_chat'
                name = 'Codever local test'
                is_direct = $true
                invite = @('@gateway:localhost')
                initial_state = @(
                    @{
                        type = 'm.room.encryption'
                        state_key = ''
                        content = @{ algorithm = 'm.megolm.v1.aes-sha2' }
                    }
                )
            }

        $encodedRoomId = [Uri]::EscapeDataString($room.room_id)
        $null = Invoke-MatrixPost `
            "http://localhost:8008/_matrix/client/v3/rooms/$encodedRoomId/join" `
            $gateway.access_token `
            @{}

        $configuration = [ordered]@{
            homeserver = 'http://localhost:8008'
            roomId = $room.room_id
            gatewayId = 'codever-local-gateway'
            tester = [ordered]@{
                userId = $tester.user_id
                deviceId = $tester.device_id
                accessToken = $tester.access_token
            }
            gateway = [ordered]@{
                userId = $gateway.user_id
                deviceId = $gateway.device_id
                accessToken = $gateway.access_token
            }
        }
        $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $outputPath -Encoding utf8

        Write-Output "Local encrypted Matrix room is ready. Credentials were written to:"
        Write-Output $outputPath
        Write-Output 'This file is ignored by Git and is only for local testing.'
    }
}
