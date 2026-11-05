// Edytor blokow i obrazow profilu. Zasoby lokalne, bez innerHTML.
'use strict';

const SP_V2_TEMPLATES = {
  classic: 'Classic — obecny układ',
  compact: 'Compact — mniejsze kafelki i kolumny',
  glass: 'Glass — tło, szkło, zegar i data',
  live: 'Live — animowany gradient',
};

function spNewAsset(snapshot) {
  return { base: snapshot, action: 'keep', file: null, type: '', filePreview: null,
    serverPreview: null, known: false, message: 'Ładowanie podglądu…', read: 0 };
}

function spRenderTemplate(editor) {
  $('#sp-template').value = editor.draft.template;
  const preview = $('#sp-template-preview');
  preview.dataset.template = editor.draft.template;
  $('#sp-template-caption').textContent = SP_V2_TEMPLATES[editor.draft.template];
  const image = $('#sp-template-background');
  const asset = editor.assets.background;
  const source = asset.action === 'upload' ? asset.filePreview :
    asset.action === 'delete' ? null : asset.serverPreview;
  image.hidden = editor.draft.template !== 'glass' || !source;
  if (source) image.src = source;
  else image.removeAttribute('src');
}

function spV2Actions(list, index, editor, render, label) {
  const up = spButton('W górę', () => change(-1));
  const down = spButton('W dół', () => change(1));
  up.disabled = index === 0;
  down.disabled = index === list.length - 1;
  function change(delta) {
    spMove(list, index, delta);
    editor.draft.configured = true;
    render();
    spUpdate();
  }
  return el('div', { class: 'sp-row-actions' }, up, down,
    spButton('Usuń ' + label, () => {
      list.splice(index, 1);
      editor.draft.configured = true;
      render();
      spUpdate();
    }, 'danger'));
}

function spTileCount(editor) {
  return editor.draft.blocks.reduce((n, block) => n + (block.tiles?.length || 0), 0);
}

function spRenderBlocks(editor) {
  const box = $('#sp-sections');
  box.replaceChildren();
  editor.draft.blocks.forEach((block, index) => {
    const row = el('div', { class: 'sp-row sp-block' });
    row.append(el('div', { class: 'card-head' },
      el('strong', {}, (index + 1) + '. ' + ({
        folder: 'Folder zakładek', custom: 'Własne kafelki', top: 'Najczęściej odwiedzane',
      }[block.type])),
      spV2Actions(editor.draft.blocks, index, editor, () => spRenderBlocks(editor), 'blok')));

    const fields = el('div', { class: 'sp-section-fields' });
    if (block.type === 'folder') {
      const select = el('select', { required: '', 'aria-label': 'Folder bloku ' + (index + 1) });
      select.append(el('option', { value: '' }, 'Wybierz folder…'));
      if (block.folderId && !editor.folderLabels.has(block.folderId))
        select.append(el('option', { value: block.folderId }, 'Niedostępny folder: ' + block.folderId));
      for (const [id, path] of editor.folderLabels) {
        const option = el('option', { value: id }, path);
        option.disabled = editor.draft.blocks.some(b =>
          b !== block && b.type === 'folder' && b.folderId === id);
        select.append(option);
      }
      select.value = block.folderId;
      select.addEventListener('change', () => {
        block.folderId = select.value;
        editor.draft.configured = true;
        spRenderBlocks(editor);
        spUpdate();
      });
      fields.append(spField('Folder w drzewie profilu', select));
      if (block.folderId && !editor.folderLabels.has(block.folderId))
        row.append(el('p', { class: 'warn small' },
          'Folder jest niedostępny. Możesz zachować ten blok albo wskazać zamiennik.'));
    }
    fields.append(spField('Nazwa bloku — opcjonalnie',
      spInput(block.title, { maxlength: '200', placeholder: 'Nazwa domyślna' },
        value => { block.title = value || null; })));
    row.append(fields);

    if (block.type === 'custom') {
      const tiles = el('div', { class: 'sp-custom-tiles' });
      block.tiles.forEach((tile, tileIndex) => {
        const color = spInput(tile.color || '#2f9e5b', { type: 'color' },
          value => { tile.color = value; });
        color.disabled = tile.color === null;
        const enabled = el('input', { type: 'checkbox' });
        enabled.checked = tile.color !== null;
        enabled.addEventListener('change', () => {
          tile.color = enabled.checked ? color.value : null;
          color.disabled = !enabled.checked;
          editor.draft.configured = true;
          spUpdate();
        });
        const colorField = el('div', {},
          el('label', { class: 'sp-color-toggle' }, enabled, 'Własny kolor'), color);
        tiles.append(el('div', { class: 'sp-custom-tile' },
          el('div', { class: 'sp-tile-fields' },
            spField('Tytuł', spInput(tile.title, { required: '', maxlength: '200' },
              value => { tile.title = value; })),
            spField('Adres HTTP lub HTTPS',
              spInput(tile.url, { required: '', maxlength: '2048', spellcheck: 'false' },
                value => { tile.url = value; })),
            colorField),
          spV2Actions(block.tiles, tileIndex, editor, () => spRenderBlocks(editor), 'kafelek')));
      });
      const add = spButton('Dodaj kafelek', () => {
        if (spTileCount(editor) >= 200) return;
        block.tiles.push({ id: crypto.randomUUID(), title: '', url: '', color: null });
        editor.draft.configured = true;
        spRenderBlocks(editor);
        spUpdate();
      });
      add.disabled = spTileCount(editor) >= 200;
      row.append(tiles, add);
      if (!block.tiles.length)
        row.append(el('p', { class: 'muted small' }, 'Ten blok nie ma jeszcze kafelków.'));
    }
    if (block.type === 'top')
      row.append(el('p', { class: 'muted small' },
        'Zawartość pochodzi wyłącznie z danej przeglądarki. Pojawi się po lokalnym włączeniu i zgodzie we wtyczce.'));
    box.append(row);
  });
  if (!editor.draft.blocks.length)
    box.append(el('p', { class: 'muted' }, editor.draft.configured
      ? 'Brak bloków — po zapisaniu strona pokaże samą wyszukiwarkę.'
      : 'Profil nie ma jeszcze układu. Obowiązuje domyślny pasek zakładek. Zapis pustego układu pozostawi samą wyszukiwarkę.'));
  $('#sp-tile-count').textContent = String(spTileCount(editor));
}

function spAddBlock(type) {
  const editor = spEditor;
  if (!editor || editor.busy || spOpening || editor.draft.blocks.length >= 64 ||
      (type === 'top' && editor.draft.blocks.some(b => b.type === 'top'))) return;
  const block = { id: crypto.randomUUID(), type, title: null };
  if (type === 'folder') block.folderId = '';
  if (type === 'custom') block.tiles = [];
  editor.draft.blocks.push(block);
  editor.draft.configured = true;
  spRenderBlocks(editor);
  spUpdate();
}

function spValidateBlocks(editor, document) {
  if (!Object.hasOwn(SP_V2_TEMPLATES, document.template) || document.blocks.length > 64)
    throw new Error('Wybierz szablon i najwyżej 64 bloki.');
  const blockIds = new Set(), folderIds = new Set(), tileIds = new Set();
  let top = 0, total = 0;
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  for (const block of document.blocks) {
    if (!validId(block.id) || blockIds.has(block.id)) throw new Error('Powtórzone ID bloku.');
    blockIds.add(block.id);
    block.title = block.title?.trim() || null;
    if (block.title && (block.title.length > 200 || /[\u0000-\u001f\u007f]/.test(block.title)))
      throw new Error('Nazwa bloku jest za długa albo zawiera znaki sterujące.');
    if (block.type === 'folder') {
      const retained = editor.base.configuration.blocks.some(b =>
        b.type === 'folder' && b.id === block.id && b.folderId === block.folderId);
      if ((!editor.folderLabels.has(block.folderId) && !retained) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(block.folderId) ||
          folderIds.has(block.folderId))
        throw new Error('Wybierz różne foldery dla bloków folderowych.');
      folderIds.add(block.folderId);
    } else if (block.type === 'custom') {
      total += block.tiles.length;
      if (total > 200) throw new Error('Maksymalnie 200 własnych kafelków w profilu.');
      for (const tile of block.tiles) {
        if (!validId(tile.id) || tileIds.has(tile.id)) throw new Error('Powtórzone ID kafelka.');
        tileIds.add(tile.id);
        tile.title = tile.title.trim();
        tile.url = tile.url.trim();
        if (!tile.title || tile.title.length > 200 || /[\u0000-\u001f\u007f]/.test(tile.title))
          throw new Error('Podaj tytuł kafelka (1–200 znaków).');
        let url;
        try { url = new URL(tile.url); } catch { throw new Error('Niepoprawny adres kafelka.'); }
        if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password ||
            tile.url.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(tile.url))
          throw new Error('Kafelek wymaga adresu HTTP lub HTTPS bez hasła i spacji.');
        if (tile.color !== null && !/^#[0-9a-f]{6}$/i.test(tile.color))
          throw new Error('Niepoprawny kolor kafelka.');
      }
    } else if (block.type !== 'top' || ++top > 1) {
      throw new Error('Dozwolony jest jeden blok „Najczęściej odwiedzane”.');
    }
  }
  document.version = 2;
  document.configured = true;
}

function spRenderAsset(editor, name) {
  const asset = editor.assets[name];
  const image = $('#sp-' + name + '-preview');
  const source = asset.action === 'upload' ? asset.filePreview :
    asset.action === 'delete' ? null : asset.serverPreview;
  image.hidden = !source;
  if (source) image.src = source;
  else image.removeAttribute('src');
  const action = asset.action === 'upload'
    ? 'Wybrano: ' + asset.file.name + ' — jeszcze nie zapisano.'
    : asset.action === 'delete' ? 'Obraz zostanie usunięty po zatwierdzeniu.'
    : asset.known ? (asset.serverPreview ? 'Obraz zapisany na serwerze.' : 'Brak obrazu w profilu.') : '';
  $('#sp-' + name + '-state').textContent = [action, asset.message].filter(Boolean).join(' ');
  $('#sp-save-' + name).textContent = asset.action === 'delete'
    ? 'Usuń ' + (name === 'logo' ? 'logo' : 'tło') + ' z serwera'
    : 'Zapisz ' + (name === 'logo' ? 'logo' : 'tło');
  spRenderTemplate(editor);
}

async function spReadAsset(editor, name, stamp) {
  const result = await spRequest(spPath(editor) + '/startpage/' + name, { image: name });
  if (result.generation !== stamp.generation || result.version !== stamp[name + 'Version'])
    throw new Error('Obraz zmienił się na serwerze. Odśwież porównanie.');
  if (!result.blob) return null;
  const max = name === 'background' ? 2 * 1024 * 1024 : 512 * 1024;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.blob.type) ||
      result.blob.size > max) throw new Error('Serwer zwrócił niepoprawny obraz.');
  return 'data:' + result.blob.type + ';base64,' + await readFile(result.blob, false);
}

async function spLoadAsset(editor, name) {
  const asset = editor.assets[name], stamp = asset.base, read = ++asset.read;
  try {
    const source = await spReadAsset(editor, name, stamp);
    if (spEditor !== editor || asset.base !== stamp || asset.read !== read) return;
    asset.serverPreview = source;
    asset.known = true;
    asset.message = '';
  } catch (error) {
    if (spEditor !== editor || asset.base !== stamp || asset.read !== read) return;
    asset.message = error.message;
  }
  spRenderAsset(editor, name);
}

function spCancelAsset(editor, name) {
  const asset = editor.assets[name];
  asset.action = 'keep';
  asset.file = null;
  asset.filePreview = null;
  $('#sp-' + name + '-file').value = '';
  spRenderAsset(editor, name);
  spUpdate();
}

function spWireAsset(name) {
  $('#sp-' + name + '-file').addEventListener('change', async event => {
    const editor = spEditor, file = event.target.files[0];
    if (!editor || !file || editor.busy || spOpening) return;
    const asset = editor.assets[name];
    const type = (file.type || ({
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    }[file.name.split('.').pop().toLowerCase()] || '')).toLowerCase();
    const max = name === 'background' ? 2 * 1024 * 1024 : 512 * 1024;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type) || file.size > max) {
      event.target.value = '';
      spMessage('Wybierz PNG, JPEG lub WebP do ' + (name === 'background' ? '2 MB.' : '512 KB.') +
        ' Poprzedni wybór pozostaje zachowany.');
      return;
    }
    Object.assign(asset, { action: 'upload', file, type, filePreview: null });
    spRenderAsset(editor, name);
    spUpdate();
    try {
      const source = 'data:' + type + ';base64,' + await readFile(file, false);
      if (spEditor === editor && asset.file === file && asset.action === 'upload') {
        asset.filePreview = source;
        spRenderAsset(editor, name);
      }
    } catch (error) {
      if (spEditor === editor && asset.file === file) spMessage(error.message);
    }
  });
  $('#sp-cancel-' + name).addEventListener('click', () => {
    if (spEditor) spCancelAsset(spEditor, name);
  });
  $('#sp-delete-' + name).addEventListener('click', () => {
    if (!spEditor) return;
    const asset = spEditor.assets[name];
    Object.assign(asset, { action: 'delete', file: null, filePreview: null });
    $('#sp-' + name + '-file').value = '';
    spRenderAsset(spEditor, name);
    spUpdate();
  });
  $('#sp-' + name + '-form').addEventListener('submit', event => {
    event.preventDefault();
    const editor = spEditor;
    if (!editor || editor.conflict || editor.assets[name].action === 'keep') return;
    void spWork(editor, name, async () => {
      const asset = editor.assets[name];
      const query = new URLSearchParams({
        generation: asset.base.generation,
        [name + 'Version']: String(asset.base[name + 'Version']),
      });
      const saved = spCheckSnapshot(await spRequest(spPath(editor) + '/startpage/' + name + '?' + query,
        asset.action === 'delete' ? { method: 'DELETE' } :
          { method: 'PUT', body: asset.file, type: asset.type }), editor.profileId);
      asset.base = saved;
      spCancelAsset(editor, name);
      await spLoadAsset(editor, name);
      spMessage('Zmiana obrazu zapisana. Pozostałe formularze zachowano.', 'ok');
    });
  });
  $('#sp-refresh-' + name).addEventListener('click', () => {
    const editor = spEditor;
    void spWork(editor, name, async () => {
      const asset = editor.assets[name];
      const current = spCheckSnapshot(await spRequest(spPath(editor) + '/startpage'), editor.profileId);
      if (asset.action !== 'keep' &&
          (current.generation !== asset.base.generation ||
           current[name + 'Version'] !== asset.base[name + 'Version'])) {
        editor.conflict = { kind: name, current };
        spRenderConflict(editor);
        spMessage('Obraz zmienił się na serwerze. Twój wybór pozostaje zachowany.');
        return;
      }
      asset.base = current;
      await spLoadAsset(editor, name);
    });
  });
}
