// Minimal test map: two rooms and a corridor. Used by unit tests and as a fallback.
export const meta = { title: 'Test Box', author: 'engine' };
export function build(m) {
  m.title = meta.title;
  // room A
  m.box([-512, -512, -64], [512, 512, 0], 'floor');
  m.box([-512, -512, 256], [512, 512, 320], 'ceiling');
  m.box([-576, -512, 0], [-512, 512, 256], 'wall');
  m.box([512, -512, 0], [576, -64, 256], 'wall');
  m.box([512, 64, 0], [576, 512, 256], 'wall');
  m.box([-512, -576, 0], [512, -512, 256], 'wall');
  m.box([-512, 512, 0], [512, 576, 256], 'wall');
  // corridor
  m.box([512, -64, -64], [1024, 64, 0], 'floor');
  m.box([512, -64, 192], [1024, 64, 256], 'ceiling');
  m.box([512, -128, 0], [1024, -64, 256], 'wall');
  m.box([512, 64, 0], [1024, 128, 256], 'wall');
  // room B
  m.box([1024, -512, -64], [2048, 512, 0], 'floor');
  m.box([1024, -512, 256], [2048, 512, 320], 'ceiling');
  m.box([2048, -512, 0], [2112, 512, 256], 'wall');
  m.box([1024, -512, 0], [1088, -64, 256], 'wall');
  m.box([1024, 64, 0], [1088, 512, 256], 'wall');
  m.box([1024, -576, 0], [2048, -512, 256], 'wall');
  m.box([1024, 512, 0], [2048, 576, 256], 'wall');
  // a 16-unit step and a 64 platform
  m.box([-256, 128, 0], [-128, 256, 16], 'floor');
  m.box([-128, 128, 0], [0, 256, 32], 'floor');
  m.box([0, 128, 0], [128, 256, 48], 'floor');
  m.box([128, 128, 0], [256, 256, 64], 'floor');
  m.jumppad([-64, -320, 0], [0, -256, 32], [256, -300, 64]);
  m.spawn([-384, 0, 24], 0);
  m.spawn([1920, 0, 24], 180);
  m.spawn([0, 384, 24], -90);
  m.spawn([1536, -384, 24], 90);
  m.item('weaponRocket', [0, 0, 20]);
  m.item('armorRed', [1536, 0, 20]);
  m.item('mega', [-384, -384, 20]);
  m.item('weaponRail', [1536, 384, 20]);
  m.item('armorYellow', [768, 0, 20]);
  m.item('weaponLightning', [-384, 384, 20]);
  m.item('health25', [256, -256, 20]);
  m.item('ammoRockets', [128, 0, 20]);
  m.light([0, 0, 200], '#ffd8a8', 1.2, 900);
  m.light([1536, 0, 200], '#a8c8ff', 1.2, 900);
  m.light([768, 0, 160], '#ffffff', 0.6, 500);
  m.nav([-384, 0, 24]); m.nav([0, 0, 24]); m.nav([384, 0, 24]); m.nav([768, 0, 24]); m.nav([1152, 0, 24]); m.nav([1536, 0, 24]); m.nav([1920, 0, 24]);
  m.nav([-384, -384, 24]); m.nav([-384, 384, 24]); m.nav([0, 384, 24]); m.nav([1536, 384, 24]); m.nav([1536, -384, 24]); m.nav([256, -256, 24]);
}
