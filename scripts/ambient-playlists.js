const MODULE_ID = "ambient-playlists";

/* ---------- Basic sanity log ---------- */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | loaded`);
});

/* ---------- UI injection: Ambient Playlist section on Ambient Sound config ---------- */

Hooks.on("renderAmbientSoundConfig", (app, html, data) => {
  const doc = app.document ?? app.object;
  if (!doc) {
    console.warn(`${MODULE_ID} | AmbientSoundConfig had no document`, app);
    return;
  }

  const root = html instanceof jQuery ? html : $(html);

  const storedEnabled  = doc.getFlag(MODULE_ID, "enabled") ?? false;
  const storedPlaylist = doc.getFlag(MODULE_ID, "playlistId") ?? "";
  const storedMode     = doc.getFlag(MODULE_ID, "mode") ?? "sequential";
  const storedFadeMs   = doc.getFlag(MODULE_ID, "fadeMs") ?? 500;
  const storedLoop     = doc.getFlag(MODULE_ID, "loop") ?? true;
  const storedChannel  = doc.getFlag(MODULE_ID, "channel") ?? "music";

  const playlists = game.playlists.contents;

  let playlistOptions = `<option value="">(none)</option>`;
  for (const pl of playlists) {
    const selected = pl.id === storedPlaylist ? "selected" : "";
    playlistOptions += `<option value="${pl.id}" ${selected}>${pl.name}</option>`;
  }

  const block = $(`
    <fieldset class="ambient-playlists">
      <legend>Ambient Playlist</legend>

      <div class="form-group">
        <label>Enable Playlist Trigger</label>
        <input type="checkbox" name="flags.${MODULE_ID}.enabled" ${storedEnabled ? "checked" : ""}>
        <p class="notes">
          If checked, this ambient sound controls a playlist instead of a single audio file.
        </p>
      </div>

      <div class="form-group">
        <label>Playlist</label>
        <select name="flags.${MODULE_ID}.playlistId">
          ${playlistOptions}
        </select>
      </div>

      <div class="form-group">
        <label>Mode</label>
        <select name="flags.${MODULE_ID}.mode">
          <option value="sequential" ${storedMode === "sequential" ? "selected" : ""}>
            Sequential
          </option>
          <option value="shuffle" ${storedMode === "shuffle" ? "selected" : ""}>
            Shuffle
          </option>
          <option value="single" ${storedMode === "single" ? "selected" : ""}>
            Single Random Track
          </option>
        </select>
      </div>

      <div class="form-group">
        <label>Loop Playlist</label>
        <input type="checkbox" name="flags.${MODULE_ID}.loop" ${storedLoop ? "checked" : ""}>
      </div>

      <div class="form-group">
        <label>Fade (ms)</label>
        <input type="number" name="flags.${MODULE_ID}.fadeMs"
               value="${storedFadeMs}" min="0" step="100">
      </div>

      <div class="form-group">
        <label>Channel Label</label>
        <select name="flags.${MODULE_ID}.channel">
          <option value="music" ${storedChannel === "music" ? "selected" : ""}>Music</option>
          <option value="ambient" ${storedChannel === "ambient" ? "selected" : ""}>Ambient</option>
          <option value="interface" ${storedChannel === "interface" ? "selected" : ""}>Interface</option>
        </select>
        <p class="notes">
          This is only a label for organization; playback volume still comes from playlist controls.
        </p>
      </div>
    </fieldset>
  `);

  // Insert right after the "Source" fieldset
  const sourceFieldset = root.find("fieldset").filter((i, el) => {
    const legend = $(el).find("legend").first().text().trim();
    return legend === "Source";
  }).first();

  if (sourceFieldset.length) {
    sourceFieldset.after(block);
  } else {
    const firstFs = root.find("fieldset").first();
    if (firstFs.length) firstFs.after(block);
    else root.append(block);
  }
});

/* ---------- Helpers for radius + playlist control ---------- */

function getPlaylistAmbients() {
  if (!canvas?.sounds) return [];
  return canvas.sounds.placeables.filter(s =>
    s.document.getFlag(MODULE_ID, "enabled") &&
    s.document.getFlag(MODULE_ID, "playlistId")
  );
}

function distanceSoundToken(sound, token) {
  const p1 = sound.center;
  const p2 = token.center;

  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const distPixels = Math.hypot(dx, dy);

  const gridSize = canvas.dimensions.size;
  const unitsPerGrid = canvas.scene.grid.distance || 5;

  return (distPixels / gridSize) * unitsPerGrid;
}

function anyPlayerTokenInside(sound) {
  // Prefer the placeable's radius; fall back to document if needed
  const radius =
    (typeof sound.radius === "number" ? sound.radius : null) ??
    (typeof sound.document.radius === "number" ? sound.document.radius : null) ??
    0;

  if (!radius || radius <= 0) return false;

  const tokens = canvas.tokens.placeables.filter(t =>
    !t.document.hidden &&
    t.actor &&
    t.isOwner
  );

  return tokens.some(t => distanceSoundToken(sound, t) <= radius);
}

/**
 * Pick a sound from the playlist based on mode.
 */
function pickSoundForMode(playlist, mode) {
  const sounds = playlist.sounds.contents.filter(s => !s.disabled);
  if (!sounds.length) return null;

  if (mode === "shuffle" || mode === "single") {
    const idx = Math.floor(Math.random() * sounds.length);
    return sounds[idx];
  }

  // "sequential": try to continue whatever is playing, otherwise first sound
  const playing = sounds.find(s => s.playing);
  return playing ?? sounds[0];
}

async function updatePlaylistForAmbient(sound) {
  const doc = sound.document;

  const playlistId = doc.getFlag(MODULE_ID, "playlistId");
  if (!playlistId) return;

  const playlist = game.playlists.get(playlistId);
  if (!playlist) return;

  const mode   = doc.getFlag(MODULE_ID, "mode") ?? "sequential";
  const fadeMs = Number(doc.getFlag(MODULE_ID, "fadeMs") ?? 500);
  const loop   = doc.getFlag(MODULE_ID, "loop") ?? true;

  const inside   = anyPlayerTokenInside(sound);
  const soundSet = playlist.sounds.contents;
  const isPlaying = soundSet.some(s => s.playing);

  // Tiny debug trace so you can see it doing work
  console.debug(`${MODULE_ID} | ambient ${doc.id} inside=${inside} playing=${isPlaying}`);

  // Nobody in range → stop playlist
  if (!inside && isPlaying && typeof playlist.stopAll === "function") {
    await playlist.stopAll({ fade: fadeMs });
    return;
  }

  // Someone entered range and nothing is playing yet → start a track
  if (inside && !isPlaying) {
    const chosen = pickSoundForMode(playlist, mode);
    if (!chosen) return;

    await playlist.playSound(chosen, { fade: fadeMs, loop });
  }
}

function refreshAllPlaylistAmbients() {
  if (!game.user.isGM) return;
  for (const sound of getPlaylistAmbients()) {
    updatePlaylistForAmbient(sound);
  }
}

/* ---------- Hooks for scene + token updates ---------- */

Hooks.on("canvasReady", () => {
  refreshAllPlaylistAmbients();
});

Hooks.on("updateToken", (doc, change, options, userId) => {
  if (!game.user.isGM) return;
  refreshAllPlaylistAmbients();
});

Hooks.on("updateAmbientSound", (doc, change, options, userId) => {
  if (!game.user.isGM) return;
  refreshAllPlaylistAmbients();
});

Hooks.on("deleteAmbientSound", (doc) => {
  if (!game.user.isGM) return;
  const playlistId = doc.getFlag(MODULE_ID, "playlistId");
  if (!playlistId) return;
  const playlist = game.playlists.get(playlistId);
  if (playlist && typeof playlist.stopAll === "function") {
    playlist.stopAll();
  }
});
