/**
 * Shared Source Priority & Default Offset Dictionary utilities and UI widget.
 * Keeps source ordering, offset defaults, `Other` immutability, and drag-and-drop
 * UI consistent across the content panel and browser-action popup.
 */
(function (root) {
  'use strict';

  const DEFAULT_SOURCE_PROFILES = [
    { id: 'abema', name: 'ABEMA', offset: 0.0, locked: false },
    { id: 'dmmtv', name: 'DMMTV', offset: 0.0, locked: false },
    { id: 'u-next', name: 'U-NEXT', offset: 0.0, locked: false },
    { id: 'amazon', name: 'Amazon', offset: 0.0, locked: false },
    { id: 'other', name: 'Other', offset: 0.0, locked: true },
    { id: 'netflix', name: 'Netflix', offset: -1.0, locked: false },
    { id: 'nanokoraws', name: 'NanokoRaws', offset: 0.0, locked: false },
    { id: 'shincaps', name: 'shincaps', offset: 0.0, locked: false },
  ];

  const DEFAULT_PREFERRED_SOURCE = DEFAULT_SOURCE_PROFILES.map((p) => p.name).join(',');

  const NAMED_SOURCE_ALIASES = {
    abema: ['abema'],
    dmmtv: ['dmmtv', 'dmm'],
    'u-next': ['u-next', 'unext'],
    amazon: ['amazon', 'amzn', 'prime'],
    netflix: ['netflix', '.nf.', '[nf]'],
    nanokoraws: ['nanokoraws', 'nanakoraws'],
    nanakoraws: ['nanakoraws', 'nanokoraws'],
    shincaps: ['shincaps'],
  };

  function roundOffset(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0.0;
    const rounded = Math.round(num * 10) / 10;
    return rounded === 0 ? 0.0 : rounded;
  }

  function cloneDefaultProfiles() {
    return DEFAULT_SOURCE_PROFILES.map((p) => ({ ...p }));
  }

  function buildSourceId(name) {
    const raw = String(name || '').trim().toLowerCase();
    if (raw === 'other' || raw === 'その他') return 'other';
    return raw.replace(/\s+/g, '-');
  }

  function normalizeSourceProfiles(profiles, legacyPreferredSource, legacyNetflixOffset) {
    const nfDefault = Number.isFinite(Number(legacyNetflixOffset))
      ? roundOffset(legacyNetflixOffset)
      : -1.0;

    let list = [];
    if (Array.isArray(profiles) && profiles.length > 0) {
      list = profiles
        .filter((p) => p && (p.id || p.name))
        .map((p) => {
          const rawId = buildSourceId(p.id || p.name);
          const isOther = rawId === 'other';
          const id = isOther ? 'other' : rawId;
          const name = isOther ? 'Other' : String(p.name || p.id).trim();
          const off = isOther ? 0.0 : roundOffset(p.offset);
          return { id, name, offset: off, locked: isOther };
        });
    } else if (typeof legacyPreferredSource === 'string' && legacyPreferredSource.trim()) {
      const tokens = legacyPreferredSource
        .split(/[,、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const seen = new Set();
      for (const tok of tokens) {
        const id = buildSourceId(tok);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const isOther = id === 'other';
        const defaultMatch = DEFAULT_SOURCE_PROFILES.find((d) => d.id === id);
        list.push({
          id,
          name: isOther ? 'Other' : (defaultMatch ? defaultMatch.name : tok),
          offset: isOther ? 0.0 : (id === 'netflix' ? nfDefault : 0.0),
          locked: isOther,
        });
      }
    } else {
      list = DEFAULT_SOURCE_PROFILES.map((p) => ({
        ...p,
        offset: p.id === 'netflix' ? nfDefault : p.offset,
      }));
    }

    // Guarantee unique IDs and ensure locked `Other` (0.0s, undeletable) is present.
    const deduped = [];
    const seenIds = new Set();
    let hasOther = false;
    for (const item of list) {
      if (!item.id || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      if (item.id === 'other') {
        hasOther = true;
        deduped.push({ id: 'other', name: 'Other', offset: 0.0, locked: true });
      } else {
        deduped.push(item);
      }
    }
    if (!hasOther) {
      deduped.push({ id: 'other', name: 'Other', offset: 0.0, locked: true });
    }
    return deduped;
  }

  function detectSourceCategory(filename, sourceProfiles) {
    const lower = (filename || '').toLowerCase();
    const profiles = Array.isArray(sourceProfiles) && sourceProfiles.length > 0
      ? sourceProfiles
      : DEFAULT_SOURCE_PROFILES;

    for (const profile of profiles) {
      const id = String(profile.id || profile.name || '').toLowerCase();
      if (!id || id === 'other') continue;
      const patterns = NAMED_SOURCE_ALIASES[id] || [
        String(profile.name || '').toLowerCase(),
        id,
      ].filter(Boolean);
      if (patterns.some((p) => p && lower.includes(p))) {
        return id;
      }
    }
    return 'other';
  }

  function formatOffsetSigned(offset) {
    const rounded = roundOffset(offset);
    const sign = rounded > 0 ? '+' : '';
    return `${sign}${rounded.toFixed(1)}s`;
  }

  function formatSourceSummary(profiles) {
    return normalizeSourceProfiles(profiles)
      .map((p, idx) => {
        const off = !p.locked && p.offset !== 0 ? ` (${formatOffsetSigned(p.offset)})` : '';
        return `${idx + 1}. ${p.name}${off}`;
      })
      .join(' · ');
  }

  const DEFAULT_LABELS = {
    title: 'Source Priority & Default Offset',
    lockedOffsetLabel: '0.0s Fixed',
    lockedDeleteTitle: 'Other is fixed at 0.0s and cannot be deleted (drag to reorder priority).',
    deleteTitle: 'Remove source',
    offsetInputTitle: 'Default offset in seconds',
    dragTitle: 'Drag to reorder priority',
    addPlaceholder: 'Add source (e.g. Crunchyroll)',
    addBtn: 'Add',
    resetBtn: 'Reset',
    hint: 'Drag to reorder · Inline default offset · Other locked at 0.0s',
  };

  /**
   * Mount an expandable/collapsible, draggable 1-to-1 source priority & offset editor.
   */
  function mountSourceDictionary({
    container,
    getProfiles,
    onChange,
    getLabels,
    startOpen = false,
  }) {
    if (!container) return null;

    const labels = () => ({ ...DEFAULT_LABELS, ...(typeof getLabels === 'function' ? getLabels() : {}) });
    let dragIndex = null;

    container.innerHTML = `
      <div class="dsub-source-accordion${startOpen ? ' open' : ''}">
        <button type="button" class="dsub-source-toggle" aria-expanded="${startOpen ? 'true' : 'false'}">
          <span class="dsub-source-toggle-title"></span>
          <span class="dsub-source-chevron">▼</span>
        </button>
        <div class="dsub-source-summary"></div>
        <div class="dsub-source-body">
          <div class="dsub-source-list"></div>
          <div class="dsub-source-add-row">
            <input type="text" class="dsub-input dsub-source-add-name" />
            <input type="number" step="0.5" value="0.0" class="dsub-input dsub-no-spin dsub-source-add-offset" style="width:64px;text-align:right;" />
            <button type="button" class="dsub-btn dsub-source-add-btn"></button>
          </div>
          <div class="dsub-source-foot">
            <span class="dsub-source-foot-hint"></span>
            <button type="button" class="dsub-btn dsub-source-reset-btn" style="padding:2px 7px;font-size:10px;width:auto;margin-top:0;"></button>
          </div>
        </div>
      </div>
    `;

    const accordion = container.querySelector('.dsub-source-accordion');
    const toggleBtn = container.querySelector('.dsub-source-toggle');
    const titleEl = container.querySelector('.dsub-source-toggle-title');
    const summaryEl = container.querySelector('.dsub-source-summary');
    const listEl = container.querySelector('.dsub-source-list');
    const addNameEl = container.querySelector('.dsub-source-add-name');
    const addOffEl = container.querySelector('.dsub-source-add-offset');
    const addBtn = container.querySelector('.dsub-source-add-btn');
    const hintEl = container.querySelector('.dsub-source-foot-hint');
    const resetBtn = container.querySelector('.dsub-source-reset-btn');

    function commit(nextProfiles) {
      const normalized = normalizeSourceProfiles(nextProfiles);
      if (typeof onChange === 'function') {
        onChange(normalized);
      }
      render();
    }

    function applyStaticLabels() {
      const L = labels();
      titleEl.textContent = L.title;
      addNameEl.placeholder = L.addPlaceholder;
      addBtn.textContent = L.addBtn;
      hintEl.textContent = L.hint;
      resetBtn.textContent = L.resetBtn;
    }

    function render() {
      applyStaticLabels();
      const L = labels();
      const profiles = normalizeSourceProfiles(
        typeof getProfiles === 'function' ? getProfiles() : DEFAULT_SOURCE_PROFILES
      );
      summaryEl.textContent = formatSourceSummary(profiles);
      summaryEl.title = summaryEl.textContent;

      listEl.replaceChildren();

      profiles.forEach((profile, idx) => {
        const row = document.createElement('div');
        row.className = `dsub-source-row${profile.locked ? ' is-other' : ''}`;
        row.draggable = true;
        row.dataset.index = String(idx);
        row.dataset.id = profile.id;
        row.title = L.dragTitle;

        const grip = document.createElement('span');
        grip.className = 'dsub-source-grip';
        grip.textContent = '⋮⋮';

        const rank = document.createElement('span');
        rank.className = 'dsub-source-rank';
        rank.textContent = String(idx + 1);

        const name = document.createElement('span');
        name.className = 'dsub-source-name';
        name.textContent = profile.name;
        name.title = profile.name;

        row.appendChild(grip);
        row.appendChild(rank);
        row.appendChild(name);

        if (profile.locked) {
          const lockPill = document.createElement('span');
          lockPill.className = 'dsub-source-lock-pill';
          lockPill.textContent = L.lockedOffsetLabel;
          lockPill.title = L.lockedDeleteTitle;

          const lockIcon = document.createElement('span');
          lockIcon.className = 'dsub-source-lock-icon';
          lockIcon.textContent = '🔒';
          lockIcon.title = L.lockedDeleteTitle;

          row.appendChild(lockPill);
          row.appendChild(lockIcon);
        } else {
          const offsetWrap = document.createElement('div');
          offsetWrap.className = 'dsub-source-offset-wrap';

          const offInput = document.createElement('input');
          offInput.type = 'number';
          offInput.step = '0.5';
          offInput.value = roundOffset(profile.offset).toFixed(1);
          offInput.title = L.offsetInputTitle;
          offInput.className = 'dsub-input dsub-no-spin dsub-source-offset-input';

          // Prevent row dragging while editing numeric offset inline.
          offInput.addEventListener('pointerdown', (e) => {
            row.draggable = false;
            e.stopPropagation();
          });
          offInput.addEventListener('focus', () => {
            row.draggable = false;
          });
          offInput.addEventListener('blur', () => {
            row.draggable = true;
          });
          offInput.addEventListener('change', () => {
            const raw = Number.isFinite(offInput.valueAsNumber)
              ? offInput.valueAsNumber
              : parseFloat(offInput.value);
            const nextVal = roundOffset(raw);
            offInput.value = nextVal.toFixed(1);
            const next = profiles.map((p, i) => (i === idx ? { ...p, offset: nextVal } : { ...p }));
            commit(next);
          });

          const unit = document.createElement('span');
          unit.className = 'dsub-source-offset-unit';
          unit.textContent = 's';

          offsetWrap.appendChild(offInput);
          offsetWrap.appendChild(unit);

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'dsub-source-del-btn';
          delBtn.textContent = '×';
          delBtn.title = L.deleteTitle;
          delBtn.style.width = 'auto';
          delBtn.style.marginTop = '0';
          delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = profiles.filter((_, i) => i !== idx);
            commit(next);
          });

          row.appendChild(offsetWrap);
          row.appendChild(delBtn);
        }

        row.addEventListener('dragstart', (e) => {
          dragIndex = idx;
          row.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(idx));
          }
        });

        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (dragIndex === idx) return;
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          row.classList.add('drag-over');
        });

        row.addEventListener('dragleave', () => {
          row.classList.remove('drag-over');
        });

        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('drag-over');
          const fallbackFrom = e.dataTransfer ? parseInt(e.dataTransfer.getData('text/plain'), 10) : NaN;
          const from = dragIndex !== null ? dragIndex : fallbackFrom;
          const to = idx;
          if (!Number.isInteger(from) || from === to || from < 0 || from >= profiles.length) return;
          const next = profiles.map((p) => ({ ...p }));
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          commit(next);
        });

        row.addEventListener('dragend', () => {
          dragIndex = null;
          listEl.querySelectorAll('.dsub-source-row').forEach((el) => {
            el.classList.remove('dragging', 'drag-over');
          });
        });

        listEl.appendChild(row);
      });
    }

    toggleBtn.addEventListener('click', () => {
      const nextOpen = !accordion.classList.contains('open');
      accordion.classList.toggle('open', nextOpen);
      toggleBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    });

    function handleAdd() {
      const name = addNameEl.value.trim();
      if (!name) return;
      const id = buildSourceId(name);
      if (!id || id === 'other') {
        addNameEl.value = '';
        return;
      }
      const rawOff = Number.isFinite(addOffEl.valueAsNumber)
        ? addOffEl.valueAsNumber
        : parseFloat(addOffEl.value);
      const offset = roundOffset(rawOff);

      const current = normalizeSourceProfiles(
        typeof getProfiles === 'function' ? getProfiles() : DEFAULT_SOURCE_PROFILES
      );
      const existingIdx = current.findIndex((p) => p.id === id);
      if (existingIdx >= 0) {
        current[existingIdx] = { ...current[existingIdx], name, offset };
      } else {
        const otherIdx = current.findIndex((p) => p.id === 'other');
        const entry = { id, name, offset, locked: false };
        if (otherIdx >= 0) {
          current.splice(otherIdx, 0, entry);
        } else {
          current.push(entry);
        }
      }
      addNameEl.value = '';
      addOffEl.value = '0.0';
      commit(current);
    }

    addBtn.addEventListener('click', handleAdd);
    addNameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    });

    resetBtn.addEventListener('click', () => {
      commit(cloneDefaultProfiles());
    });

    render();

    return {
      render,
      refreshLabels: render,
      setOpen(open) {
        accordion.classList.toggle('open', Boolean(open));
        toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      },
    };
  }

  root.DSubSourceProfiles = {
    DEFAULT_SOURCE_PROFILES,
    DEFAULT_PREFERRED_SOURCE,
    NAMED_SOURCE_ALIASES,
    roundOffset,
    cloneDefaultProfiles,
    buildSourceId,
    normalizeSourceProfiles,
    detectSourceCategory,
    formatOffsetSigned,
    formatSourceSummary,
    mountSourceDictionary,
  };
})(typeof window !== 'undefined' ? window : globalThis);
