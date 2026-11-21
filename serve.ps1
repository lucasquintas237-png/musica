# serve.ps1 - servidor local de la app de musica (sin dependencias, PowerShell 5.1+)
# Uso:  powershell -ExecutionPolicy Bypass -File serve.ps1
# Abrir SIEMPRE por nombre (http://localhost:5500 o http://NOMBRE-PC.local:5500), nunca por IP:
# YouTube devuelve el error 150 cuando el origen es una direccion IP.
param([int]$Port = 5500)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$http = New-Object System.Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(20)
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
[void]$http.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', $UA)
[void]$http.DefaultRequestHeaders.TryAddWithoutValidation('Accept-Language', 'es-ES,es;q=0.9,en;q=0.8')

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'; '.png' = 'image/png'
  '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'; '.txt' = 'text/plain; charset=utf-8'
}

# Codigo que atiende cada conexion (se ejecuta en un runspace aparte para atender varias a la vez)
$worker = {
  param($client, $root, $http, $mime)

  $latin1 = [Text.Encoding]::GetEncoding(28591)

  function Send-Response($stream, [int]$code, [string]$type, [byte[]]$body, [string]$cache = 'no-cache') {
    $reason = @{ 200 = 'OK'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 500 = 'Internal Server Error'; 502 = 'Bad Gateway' }[$code]
    if (-not $body) { $body = [byte[]]@() }
    $head = "HTTP/1.1 $code $reason`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: $cache`r`nConnection: close`r`n`r`n"
    $hb = [Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  }

  function Send-Text($stream, [int]$code, [string]$text) {
    Send-Response $stream $code 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($text))
  }

  # Hace la peticion al servicio externo y devuelve la respuesta tal cual al navegador
  function Proxy($stream, [string]$method, [string]$url, [byte[]]$body, [hashtable]$headers, [string]$cache = 'no-cache') {
    $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($method)), $url)
    if ($headers) { foreach ($k in $headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, $headers[$k]) } }
    if ($body -and $body.Length -gt 0) {
      $req.Content = New-Object System.Net.Http.ByteArrayContent(, $body)
      $req.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json')
    }
    $resp = $http.SendAsync($req).GetAwaiter().GetResult()
    $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $type = 'application/octet-stream'
    if ($resp.Content.Headers.ContentType) { $type = $resp.Content.Headers.ContentType.ToString() }
    $code = [int]$resp.StatusCode
    if (@(200, 204, 400, 403, 404, 500) -notcontains $code) { $code = 502 }
    Send-Response $stream $code $type $bytes $cache
  }

  try {
    $client.ReceiveTimeout = 15000
    $stream = $client.GetStream()

    # Leer cabeceras
    $buf = New-Object byte[] 16384
    $ms = New-Object IO.MemoryStream
    $headerEnd = -1
    while ($headerEnd -lt 0) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { return }
      $ms.Write($buf, 0, $n)
      $text = $latin1.GetString($ms.ToArray())
      $headerEnd = $text.IndexOf("`r`n`r`n")
      if ($ms.Length -gt 262144) { return }
    }
    $all = $ms.ToArray()
    $lines = $text.Substring(0, $headerEnd).Split("`n") | ForEach-Object { $_.TrimEnd("`r") }
    $parts = $lines[0].Split(' ')
    $method = $parts[0]
    $target = $parts[1]
    $len = 0
    foreach ($l in $lines) { if ($l -match '^(?i)content-length:\s*(\d+)') { $len = [int]$Matches[1] } }

    # Leer cuerpo
    $bodyStart = $headerEnd + 4
    $body = New-Object byte[] $len
    $have = [Math]::Min($len, $all.Length - $bodyStart)
    if ($have -gt 0) { [Array]::Copy($all, $bodyStart, $body, 0, $have) }
    while ($have -lt $len) {
      $n = $stream.Read($body, $have, $len - $have)
      if ($n -le 0) { break }
      $have += $n
    }

    $path = $target
    $query = ''
    $qi = $target.IndexOf('?')
    if ($qi -ge 0) { $path = $target.Substring(0, $qi); $query = $target.Substring($qi + 1) }
    $path = [Uri]::UnescapeDataString($path)

    [Console]::WriteLine(("{0}  {1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $method, $target))

    # --- YouTube Music (API interna youtubei: search, next, browse) ---
    if ($path -match '^/api/ytm/(search|next|browse|player|music/get_search_suggestions)$') {
      if ($method -ne 'POST') { Send-Text $stream 405 'POST'; return }
      $ep = $Matches[1]
      Proxy $stream 'POST' "https://music.youtube.com/youtubei/v1/$ep`?prettyPrint=false" $body @{
        'Origin' = 'https://music.youtube.com'; 'Referer' = 'https://music.youtube.com/'
        'X-Youtube-Client-Name' = '67'; 'X-Youtube-Client-Version' = '1.20241106.01.00'
      }
      return
    }

    # --- Letras (LRCLIB) ---
    if ($path -match '^/api/lrc/(get|search)$') {
      Proxy $stream 'GET' ("https://lrclib.net/api/" + $Matches[1] + "?" + $query) $null @{ 'Lrclib-Client' = 'MusicaLocal/1.0' } 'max-age=86400'
      return
    }

    # --- Spotify (pagina embed publica: playlist, album o track) ---
    if ($path -match '^/api/spotify/(playlist|album|track)/([A-Za-z0-9]{10,40})$') {
      Proxy $stream 'GET' ("https://open.spotify.com/embed/" + $Matches[1] + "/" + $Matches[2]) $null @{} 'max-age=600'
      return
    }

    # --- Portadas (para poder leer sus colores sin problemas de CORS) ---
    if ($path -eq '/api/img') {
      $u = ''
      foreach ($kv in $query.Split('&')) { if ($kv.StartsWith('u=')) { $u = [Uri]::UnescapeDataString($kv.Substring(2)) } }
      $uri = $null
      if (-not [Uri]::TryCreate($u, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https') { Send-Text $stream 400 'url'; return }
      $okHost = $uri.Host -match '(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com|scdn\.co|spotifycdn\.com)$'
      if (-not $okHost) { Send-Text $stream 403 'host'; return }
      Proxy $stream 'GET' $uri.AbsoluteUri $null @{} 'max-age=604800'
      return
    }

    if ($path.StartsWith('/api/')) { Send-Text $stream 404 'api'; return }

    # --- Archivos estaticos ---
    if ($path -eq '/') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/').Replace('/', '\'))))
    if (-not $file.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { Send-Text $stream 403 'no'; return }
    if (-not [IO.File]::Exists($file)) { Send-Text $stream 404 'No encontrado'; return }
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $type = $mime[$ext]
    if (-not $type) { $type = 'application/octet-stream' }
    Send-Response $stream 200 $type ([IO.File]::ReadAllBytes($file))
  }
  catch {
    [Console]::WriteLine("Error: " + $_.Exception.Message)
    try { Send-Text $stream 502 $_.Exception.Message } catch {}
  }
  finally {
    try { $client.Close() } catch {}
  }
}

$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $Port)
try { $listener.Start() }
catch { Write-Host "No se pudo abrir el puerto $Port (esta ocupado?)." -ForegroundColor Red; exit 1 }

$pool = [RunspaceFactory]::CreateRunspacePool(1, 12)
$pool.Open()
$jobs = New-Object System.Collections.ArrayList

$name = $env:COMPUTERNAME.ToLower()
Write-Host ''
Write-Host '  Musica - servidor en marcha' -ForegroundColor Cyan
Write-Host "  En este PC:          http://localhost:$Port"
Write-Host "  Desde otro aparato:  http://$name.local:$Port"
Write-Host '  No uses la direccion IP: YouTube da el error 150 y salta canciones.' -ForegroundColor Yellow
Write-Host '  Ctrl+C para parar.'
Write-Host ''

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $ps = [PowerShell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($worker).AddArgument($client).AddArgument($root).AddArgument($http).AddArgument($mime)
    [void]$jobs.Add(@{ ps = $ps; h = $ps.BeginInvoke() })
    foreach ($j in @($jobs)) {
      if ($j.h.IsCompleted) {
        try { [void]$j.ps.EndInvoke($j.h) } catch {}
        $j.ps.Dispose()
        $jobs.Remove($j)
      }
    }
  }
}
finally {
  $listener.Stop()
  $pool.Close()
}
