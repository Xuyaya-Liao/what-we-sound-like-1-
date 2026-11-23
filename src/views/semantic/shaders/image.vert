// image.vert: the vertex shader. It runs once for each corner of the rectangle that
// covers the canvas, and puts it in place. The interesting part is image.frag.
//
// p5 supplies these: the corner's position and its texture coordinate (0–1 across
// the rectangle), and the camera matrices.

attribute vec3 aPosition;
attribute vec2 aTexCoord;

uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;

// Passed on to image.frag, smoothly blended for every pixel in between
varying vec2 vTexCoord;

void main() {
  vTexCoord = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
