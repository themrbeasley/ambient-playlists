const MODULE_ID = "ambient-playlists";

/*
 * Ambient Playlists Module
 *
 * This module allows an Ambient Sound on the canvas to drive playback of a
 * Foundry playlist. Instead of using the built‑in Playlist playback which
 * always plays globally, this module swaps the AmbientSoundDocument's path
 * with the selected playlist track. This ensures the sound obeys the
 * scene's positional audio rules—tokens inside the radius hear it, tokens
 * outside do not.
 */

// Log once on init so we can confirm the module loaded
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | loaded`);
});

/**
 * Inject the Ambient Playlist configuration UI into the Ambient Sound
 * configuration sheet. This adds controls to select a playlist, choose
 * playback mode (sequential, shuffle or single random track), set a fade
 * duration and loop behaviour, and mark the sound as playlist‑driven.
 */
Hooks.on("renderAmbientSoundConfig", (app, html, data) => {
  // Modern sheets expose their document on app.document; fallback to
  // app.object for older compatibility.
  const doc = app.document ?? app.object;
  if (!doc) return;

  // html is the <form>; wrap it so we can use jQuery find operations
  const root = html instanceof jQuery ? html : $(html);

  // Pull any existing flag values from the document; these determine
  // whether playlist playback is enabled, which playlist to play from and
  // the playback options.
  const storedEnabled  = doc.getFlag(MODULE_ID, "enabled") ?? false;
  const storedPlaylist = doc.getFlag(MODULE_ID, "playlistId") ?? "";
  const storedMode     = doc.getFlag(MODULE_ID, "mode") ?? "sequential";
  const storedFadeMs   = doc.getFlag(MODULE_ID, "fadeMs") ?? 500;
  const storedLoop     = doc.getFlag(MODULE_ID, "loop") ?? true;
  const storedChannel  = doc.getFlag(MODULE_ID, "channel") ?? "music";

  // Build the playlist selector options from all playlists owned by the world
  const playlists = game.playlists.contents;
  let playlistOptions = `<option value="">(none)</option>`;
  for (const pl of playlists) {
    const selected = pl.id === storedPlaylist ? "selected" : "";
    playlistOptions += `<option value="${pl.id}" ${selected}>${pl.name}</option>`;
  }

  // Construct the fieldset with our custom controls. The legend is labelled
  // Ambient Playlist as requested. Note that the descriptive paragraph
  // emphasises that the ambient sound will control a playlist instead of
  // playing a single audio file.
  const block = $(
    `<fieldset class="ambient-playlists">
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
          This is only a label for organisation; playback volume still comes from playlist controls.
        </p>
      </div>
    </fieldset>`
  );

  // Find the "Source" fieldset and insert our controls immediately after it
  const sourceFieldset = root.find("fieldset").filter((i, el) => {
    const legend = $(el).find("legend").first().text().trim();
    return legend === "Source";
  }).first();

  if (sourceFieldset.length) {
    sourceFieldset.after(block);
  } else {
    // Fallback: insert after first fieldset if Source isn't found
    const firstFs = root.find("fieldset").first();
    if (firstFs.length) firstFs.after(block);
    else root.append(block);
  }
});

/* ---------- Helper functions for positional logic ---------- */

/**
 * Return all ambient sound placeables on the canvas that have our flag
 * enabled. These are the sounds we need to monitor for token proximity.
 */
function getPlaylistAmbients() {
  if (!canvas?.sounds) return [];
  return canvas.sounds.placeables.filter((s) =>
    s.document.getFlag(MODULE_ID, "enabled") &&
    s.document.getFlag(MODULE_ID, "playlistId")
  );
}

/**
 * Compute the scene unit distance between an ambient sound and a token.
 */
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

/**
 * Determine whether any player‑owned token is currently within the
 * radius of an ambient sound. The radius can be stored on the placeable
 * or the document depending on version; fallback appropriately.
 */
function anyPlayerTokenInside(sound) {
  const radius =
    (typeof sound.radius === "number" ? sound.radius : null) ??
    (typeof sound.document.radius === "number" ? sound.document.radius : null) ??
    0;
  if (!radius || radius <= 0) return false;
  const tokens = canvas.tokens.placeables.filter(
    (t) => !t.document.hidden && t.actor && t.isOwner
  );
  return tokens.some((t) => distanceSoundToken(sound, t) <= radius);
}

/**
 * Select a sound from a playlist according to the chosen mode. Sequential
 * will continue the currently playing track if one is active, otherwise
 * start from the first track. Shuffle and single select a random track.
 */
function pickSoundForMode(playlist, mode) {
  const sounds = playlist.sounds.contents.filter((s) => !s.disabled);
  if (!sounds.length) return null;
  if (mode === "shuffle" || mode === "single") {
    const idx = Math.floor(Math.random() * sounds.length);
    return sounds[idx];
  }
  const playing = sounds.find((s) => s.playing);
  return playing ?? sounds[0];
}

/**
 * Update the ambient sound to point at the selected track from the playlist.
 * If no tokens are within range, optionally clear the path to silence it.
 * This method replaces global playlist playback with per‑ambient positional
 * audio by updating the document's path. Foundry handles the actual
 * positional playback automatically.
 */
async function updatePlaylistForAmbient(sound) {
  const doc = sound.document;
  const playlistId = doc.getFlag(MODULE_ID, "playlistId");
  if (!playlistId) return;
  const playlist = game.playlists.get(playlistId);
  if (!playlist) return;
  const mode   = doc.getFlag(MODULE_ID, "mode") ?? "sequential";
  const fadeMs = Number(doc.getFlag(MODULE_ID, "fadeMs") ?? 500);
  const loop   = doc.getFlag(MODULE_ID, "loop") ?? true;
  const inside = anyPlayerTokenInside(sound);

  // Debug output to track state transitions; visible in console
  console.debug(
    `${MODULE_ID} | ambient ${doc.id} inside=${inside} path=${doc.path}`
  );

  // If no players are within the radius, clear the sound's path to stop playback
  if (!inside) {
    if (doc.path) {
      await doc.update({ path: null });
    }
    return;
  }

  // A player token is within range; select a track and set the path accordingly
  const chosen = pickSoundForMode(playlist, mode);
  if (!chosen) return;
  // If the chosen track is already set as the path, do nothing to avoid
  // restarting playback on every token update
  if (doc.path === chosen.path) return;
  // Update the document's path; include fade and loop flags in the
  // update's flags so they can be referenced later if desired
  await doc.update({
    path: chosen.path,
    flags: {
      [MODULE_ID]: {
        fadeMs,
        loop,
      },
    },
  });
}

/**
 * Iterate over every ambient sound flagged for playlist control and
 * update its playback based on token proximity. Only the GM client
 * drives this logic to avoid duplicate updates from multiple users.
 */
function refreshAllPlaylistAmbients() {
  if (!game.user.isGM) return;
  for (const sound of getPlaylistAmbients()) {
    updatePlaylistForAmbient(sound);
  }
}

/* ---------- Hooks: respond to scene and token changes ---------- */

// When the canvas is ready (scene activated) refresh all playlist ambients
Hooks.on("canvasReady", () => {
  refreshAllPlaylistAmbients();
});

// When any token updates (movement, creation, deletion), recheck proximities
Hooks.on("updateToken", (doc, change, options, userId) => {
  if (!game.user.isGM) return;
  refreshAllPlaylistAmbients();
});

// When an ambient sound document updates (for example if its position or
// radius changes), refresh the state of all playlist ambients
Hooks.on("updateAmbientSound", (doc, change, options, userId) => {
  if (!game.user.isGM) return;
  refreshAllPlaylistAmbients();
});

// When an ambient sound is deleted, ensure any playing track from its
// playlist is stopped by clearing its path. This avoids lingering audio
// after deletion. Only the GM needs to do this.
Hooks.on("deleteAmbientSound", (doc) => {
  if (!game.user.isGM) return;
  if (!doc.getFlag(MODULE_ID, "enabled")) return;
  // Clear the path if set
  if (doc.path) {
    doc.update({ path: null });
  }
});