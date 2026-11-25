--[[
  Música — app para el Android Auto de Custom Shaders Patch (Assetto Corsa).
  Abre la web Música en la pantalla del coche, con el navegador integrado (CEF).

  Diferencias con la app «Web» que trae el Android Auto (por las que ahí la música fallaba):
  • Se presenta como Chrome de Android, no como iPhone. Con el agente de iPhone, YouTube puede
    elegir formatos de audio que este Chromium no reproduce, y unas veces suena y otras no.
  • Sin el filtro de anuncios: bloquea, entre otras cosas, la primera petición de audio de
    YouTube (videoplayback con rn=1) y muchísimos dominios, y eso corta la reproducción.
  • Lleva «MusicaAC» en el agente, para que la web sepa que está en el coche y se adapte.

  Instalar: copiar esta carpeta en
    assettocorsa/extension/lua/cars/android_auto/apps/musica
]]
local WebBrowser = require('shared/web/browser')

local HOME = 'https://musica.lucasquintas237.workers.dev/'
local UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 MusicaAC/1.0'
local DENSITY = 0.8

local page ---@type WebBrowser
local keyboard
local navbar, navbarActive, navbarHold = 0, 0, 0
local btnSize = vec2(32, 32)

local function getPage()
  if page then return page end
  page = WebBrowser({
    dataKey = '',                 -- mismo perfil que la app Web: la sesión iniciada se conserva
    backgroundColor = rgbm(0.06, 0.06, 0.07, 1),
    redirectAudio = false,
  })
    :setMobileMode('landscape')
    :setColorScheme('dark')
    :setPixelDensity(DENSITY)
    :setUserAgent(UA)
    :drawTouches(rgbm(1, 1, 1, 0.35))
    :onDrawEmpty('message')
    :onPopup(function (tab, data)
      -- enlaces que quieren abrir otra ventana (Wikipedia, Spotify…): en la misma
      if data.userGesture then tab:navigate(data.targetURL) end
    end)
    :onOpen(function (tab, data)
      if data.userGesture then tab:navigate(data.targetURL) end
    end)
    :navigate(HOME)
  return page
end

return function (dt)
  touchscreen.forceAwake()
  system.fullscreen()
  touchscreen.boostFrameRate()

  local p = getPage()
  local size = ui.availableSpace()
  ui.dummy(size)
  p:resize(size * (1 / DENSITY))
  local r1, r2 = ui.itemRect()
  if not p:focused() then p:focus(true) end
  p:draw(r1, r2, false)

  -- toques: a la web, salvo arriba del todo cuando se ve la barra
  if touchscreen.touched() then
    local pos = ui.mouseLocalPos()
    if pos.y < size.y - math.max(0, touchscreen.keyboardOffset() - system.bottomBarHeight) and pos.y > 32 * navbar then
      p:touchInput({ pos:div(size) })
      -- deslizar hacia abajo enseña la barra un momento
      if ui.mouseDelta().y > 20 then
        navbarActive, navbarHold = 1, os.preciseClock() + 2
      end
    else
      p:touchInput({})
    end
  else
    p:touchInput({})
    keyboard = p:requestedVirtualKeyboard()
  end
  if navbarActive == 1 and navbarHold < os.preciseClock() then navbarActive = 0 end

  -- teclado de la pantalla (iniciar sesión, buscar…)
  if keyboard then
    local c = touchscreen.inputBehaviour()
    if type(c) == 'string' then
      p:textInput(c)
    elseif type(c) == 'number' then
      p:keyEvent(c, false)
      p:keyEvent(c, true)
    end
  end

  -- barra: atrás, recargar, inicio (aparece al deslizar hacia abajo o mientras carga)
  navbar = math.applyLag(navbar, navbarActive, 0.8, dt)
  if navbar > 0.01 or p:loading() then
    ui.setCursor(vec2(0, -32 + 32 * navbar))
    ui.childWindow('##musicaNav', vec2(ui.windowWidth(), 33), function ()
      if navbar > 0.01 then
        ui.drawRectFilled(vec2(), vec2(ui.windowWidth(), 32), rgbm.colors.black)
        ui.setCursor(vec2(40, 0))
        if touchscreen.button('##back', btnSize, rgbm.colors.black, 0, ui.Icons.ArrowLeft, 14, not p:canGoBack()) then
          p:navigate('back'); navbarHold = os.preciseClock() + 2
        end
        ui.sameLine(0, 12); ui.setCursorY(0)
        if touchscreen.button('##reload', btnSize, rgbm.colors.black, 0, ui.Icons.Restart, 14) then
          p:reload(true); navbarHold = os.preciseClock() + 2
        end
        ui.sameLine(0, 12); ui.setCursorY(0)
        if touchscreen.button('##home', btnSize, rgbm.colors.black, 0, ui.Icons.Home, 14) then
          p:navigate(HOME); navbarHold = os.preciseClock() + 2
        end
        ui.sameLine(0, 20); ui.setCursorY(8)
        ui.text(p:title(true) or 'Música')
      end
      if p:loading() then
        ui.drawSimpleLine(vec2(0, 32), vec2(ui.windowWidth() * p:loadingProgress(), 32), rgbm(0.4, 0.7, 1, 1), 2)
      end
    end)
  end
end
