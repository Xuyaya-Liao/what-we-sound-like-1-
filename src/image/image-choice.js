// image-choice.js: chooses which image to show for a label (step 7).
//
// Each label has a "shuffle bag": all its images in random order. Every time the
// label is chosen, the next image comes out of its bag; when the bag is empty, it is
// refilled and shuffled again. So within a label, every image is shown once before
// any image is shown twice.
//
// On top of that, the last few images shown (CONFIG.images.recent, but never more
// than half of the label's images) are avoided: when a bag has just been refilled,
// its first image might be the one still on screen. An image shown recently is only
// taken when every image left is recent too, and then the one shown longest ago.

// images: the image list from data/manifest.json ([{ id, file, title, label, … }])
// recentLimit: how many of the last images shown to avoid
export function createImageChooser(images, recentLimit) {
  // label → all its images
  const byLabel = new Map();
  for (const image of images) {
    if (!byLabel.has(image.label)) byLabel.set(image.label, []);
    byLabel.get(image.label).push(image);
  }

  const bags = new Map(); // label → the images not yet shown in this pass, in order
  const recent = []; // the last images shown (any label), oldest first

  return {
    // label → { image, left, total }, or undefined if the label has no images.
    // left: how many images are still in this label's bag after this one
    next(label) {
      const all = byLabel.get(label);
      if (!all?.length) return undefined;

      let bag = bags.get(label);
      if (!bag?.length) {
        bag = shuffle(all);
        bags.set(label, bag);
      }

      // Avoid at most half of this label's images. Avoiding more leaves no choice:
      // with 5 images and the last 4 avoided, every pass came out in the same order.
      const avoid = recent.slice(-Math.min(recentLimit, Math.floor(all.length / 2)));

      // How recently an image was shown: -1 = not recently, 0 = longest ago, …
      // Take the first one in the bag with the lowest value.
      const age = (image) => avoid.indexOf(image);
      let best = 0;
      for (let i = 1; i < bag.length; i++) {
        if (age(bag[i]) < age(bag[best])) best = i;
      }
      const [image] = bag.splice(best, 1);

      recent.push(image);
      while (recent.length > recentLimit) recent.shift();
      return { image, left: bag.length, total: all.length };
    },
  };
}

// A shuffled copy of a list (Fisher–Yates: every order is equally likely)
function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
