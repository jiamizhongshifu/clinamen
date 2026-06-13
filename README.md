# Clinamen

An interactive web artwork inspired by Celeste Boursier-Mougenot's installation *clinamen* at the Bourse de Commerce in Paris.

沐浴在玻璃穹顶透进的日光当中，被壮丽的历史壁画环绕，眼观水景，耳听陶瓷相互碰撞时发出的清脆声响，观者会不自觉慢下来，坠入一场白日梦般的冥想。

这个网页作品以法国艺术家 Celeste Boursier-Mougenot 的大型装置作品《clinamen》为灵感：蓝色水面上漂浮着白瓷碗，碗随着水流缓慢移动、靠近、碰撞；穹顶天窗的光影投射在水面上，水波、倒影、虚影和陶瓷声共同构成一个可以在浏览器中体验的流动音景。

## Preview

- Live site: [https://clinamen.vercel.app](https://clinamen.vercel.app)
- Repository: [https://github.com/jiamizhongshifu/clinamen](https://github.com/jiamizhongshifu/clinamen)

## Experience

- Floating white ceramic bowls rendered from GLB models
- Procedural blue water with ripple simulation
- Dome skylight reflection inspired by the glass roof of the Bourse de Commerce
- Water-bottom shadows and soft surface reflections
- Subtle bowl movement, perspective scaling, and water-driven bobbing
- Looping ambient ceramic collision audio
- Pointer interaction that disturbs the water surface

## Technical Stack

This project is intentionally built as a lightweight static web page.

- Vanilla HTML, CSS, and JavaScript
- Three.js for GLB bowl rendering
- Custom GLSL shaders for ceramic lighting and water rendering
- WebGL water simulation using a height-field ripple texture
- Static audio playback for the ceramic soundscape
- Vercel for deployment

## Local Development

Run a local static server from the project root:

```bash
python3 -m http.server 4174
```

Then open:

```text
http://127.0.0.1:4174/
```

The page uses browser audio playback, so background audio starts after user interaction.

## Project Structure

```text
.
├── index.html
├── styles.css
├── app.js
├── assets/
│   ├── base2.glb
│   ├── base3.glb
│   ├── base4.glb
│   └── clinamen-loop-64k.mp3
└── vendor/
    └── three/
```

## Notes

This is a personal web interpretation and technical study inspired by *clinamen*. It is not an official reproduction of the original installation or affiliated with Celeste Boursier-Mougenot, Bourse de Commerce, or Pinault Collection.

The work focuses on translating the feeling of the installation into a browser-based scene: the quiet blue of the pool, the porcelain bowls, the dome light, the water movement, and the meditative sound of ceramic contact.

## Credits

Inspired by:

- Celeste Boursier-Mougenot, *clinamen*
- Bourse de Commerce, Paris
- The sensory relationship between water, ceramic objects, architecture, and sound

