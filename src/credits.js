// credits.js: fills credits.html with every image and sound from the library.

import { loadLibrary } from "./library.js";

// A tiny helper for building HTML elements:
// make("p", "hello", "hint") creates <p class="hint">hello</p>
function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

// One line of attribution: "Title · Author · License (link)"
function credit(item) {
  const line = make("p", "", "credit");
  const title = make("a", item.title);
  title.href = item.sourceUrl;
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  const license = make("a", item.licenseName);
  license.href = item.licenseUrl;
  license.target = "_blank";
  license.rel = "noopener noreferrer";
  line.append(title, ` · ${item.author} · `, license);
  return line;
}

// Group a list by one of its fields: groupBy(sounds, "category") → { rain: [...], wind: [...] }
function groupBy(items, field) {
  const groups = {};
  for (const item of items) {
    (groups[item[field]] ??= []).push(item);
  }
  return groups;
}

const library = await loadLibrary();
document.getElementById("summary").textContent =
  `${library.images.length} images in ${library.labels.length} labels · ` +
  `${library.sounds.length} sounds · built from snapshot ${library.snapshot}`;

// ---- Images: one section per label, in the order of config/labels.json ----
const imagesByLabel = groupBy(library.images, "label");
for (const label of library.labels) {
  const section = make("section");
  section.append(make("h3", `${label.name} (${label.imageCount})`), make("p", label.description, "hint"));
  const grid = make("div", "", "grid");
  for (const image of imagesByLabel[label.id] ?? []) {
    const card = make("figure");
    const picture = make("img");
    picture.src = image.file;
    picture.alt = image.title;
    picture.loading = "lazy"; // only download when scrolled into view
    card.append(picture, credit(image));
    grid.append(card);
  }
  section.append(grid);
  document.getElementById("images").append(section);
}

// ---- Sounds: one section per category ----
const soundsByCategory = groupBy(library.sounds, "category");
for (const [category, sounds] of Object.entries(soundsByCategory)) {
  const section = make("section");
  section.append(make("h3", `${category.replaceAll("_", " ")} (${sounds.length})`));
  const list = make("div", "", "sound-list");
  for (const sound of sounds) {
    const row = make("div", "", "sound");
    const player = make("audio");
    player.src = sound.file;
    player.controls = true;
    player.preload = "none"; // only download when play is pressed
    row.append(player, credit(sound));
    list.append(row);
  }
  section.append(list);
  document.getElementById("sounds").append(section);
}
