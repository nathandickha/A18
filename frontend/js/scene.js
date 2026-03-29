// frontend/js/scene.js
// Safe override: no world-axis flips; HDRI aligned via sky-dome; ground void preserved
import * as THREE from "https://esm.sh/three@0.158.0";
import { OrbitControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "https://esm.sh/three@0.158.0/examples/jsm/environments/RoomEnvironment.js";

let dirLight;

const RAISED_SPA_CHANNEL_GAP = 0.15; // 150mm clear gap from spa outer wall
const RAISED_SPA_CHANNEL_WALL_OFFSET = 0.45; // inner face of channel wall sits 450mm off spa
const RAISED_SPA_THRESHOLD_Z = 0.05; // 50mm above pool/ground
const GROUND_SPA_CLIP_INSET = 0.03; // pull ground void 30mm back under the channel wall to hide the seam

function getGroundSpaClipMargins(spaGroup, poolGroup = null) {
  const margins = getSpaChannelMargins(spaGroup, poolGroup);
  return {
    minX: margins.minX > 0 ? Math.max(0, margins.minX - GROUND_SPA_CLIP_INSET) : 0,
    maxX: margins.maxX > 0 ? Math.max(0, margins.maxX - GROUND_SPA_CLIP_INSET) : 0,
    minY: margins.minY > 0 ? Math.max(0, margins.minY - GROUND_SPA_CLIP_INSET) : 0,
    maxY: margins.maxY > 0 ? Math.max(0, margins.maxY - GROUND_SPA_CLIP_INSET) : 0
  };
}

function _r3(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0; }

function getGroundVoidCacheKey(poolGroup) {
  const pts = getPoolFootprintWorldPts(poolGroup) || [];
  return pts.map((p) => `${_r3(p.x)},${_r3(p.y)}`).join('|');
}

function getSpaClipCacheKey(spaGroup, poolGroup = null) {
  if (!spaGroup) return 'no-spa';
  spaGroup.updateMatrixWorld?.(true);
  const pos = new THREE.Vector3();
  spaGroup.getWorldPosition(pos);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const margins = getGroundSpaClipMargins(spaGroup, poolGroup);
  return [
    _r3(pos.x), _r3(pos.y), _r3(pos.z),
    _r3(quat.x), _r3(quat.y), _r3(quat.z), _r3(quat.w),
    _r3(spaGroup.userData?.spaLength || 0),
    _r3(spaGroup.userData?.spaWidth || 0),
    _r3(spaGroup.userData?.height || 0),
    spaGroup.userData?.snapSide || '',
    _r3(margins.minX || 0), _r3(margins.maxX || 0), _r3(margins.minY || 0), _r3(margins.maxY || 0)
  ].join('|');
}

function getSpaChannelCacheKey(spaGroup, poolGroup = null) {
  if (!spaGroup) return 'no-spa';
  spaGroup.updateMatrixWorld?.(true);
  const pos = new THREE.Vector3();
  spaGroup.getWorldPosition(pos);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const margins = getSpaChannelMargins(spaGroup, poolGroup);
  return [
    _r3(pos.x), _r3(pos.y), _r3(pos.z),
    _r3(quat.x), _r3(quat.y), _r3(quat.z), _r3(quat.w),
    _r3(spaGroup.userData?.spaLength || 0),
    _r3(spaGroup.userData?.spaWidth || 0),
    _r3(spaGroup.userData?.height || 0),
    spaGroup.userData?.snapSide || '',
    _r3(margins.minX || 0), _r3(margins.maxX || 0), _r3(margins.minY || 0), _r3(margins.maxY || 0)
  ].join('|');
}

function getPoolFootprintWorldPts(poolGroup) {
  const outerPts = poolGroup?.userData?.outerPts;
  if (!Array.isArray(outerPts) || !outerPts.length) return null;

  const sx = (poolGroup.scale && isFinite(poolGroup.scale.x)) ? poolGroup.scale.x : 1;
  const sy = (poolGroup.scale && isFinite(poolGroup.scale.y)) ? poolGroup.scale.y : 1;
  const px = (poolGroup.position && isFinite(poolGroup.position.x)) ? poolGroup.position.x : 0;
  const py = (poolGroup.position && isFinite(poolGroup.position.y)) ? poolGroup.position.y : 0;

  return outerPts.map((v) => ({ x: v.x * sx + px, y: v.y * sy + py }));
}

function getPoolFootprintBoundsWorld(poolGroup) {
  const pts = getPoolFootprintWorldPts(poolGroup);
  if (!pts?.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    const x = Number.isFinite(p.x) ? p.x : 0;
    const y = Number.isFinite(p.y) ? p.y : 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  return { minX, maxX, minY, maxY };
}

function isPointInsidePolygon2D(point, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function isPointInsidePoolFootprint(poolGroup, point) {
  const poly = getPoolFootprintWorldPts(poolGroup);
  if (!poly) return false;
  return isPointInsidePolygon2D(point, poly);
}

function getOutsideIntervalsAlongSide(center, axisAlong, axisAcross, acrossLocal, alongMin, alongMax, poolGroup) {
  const poly = getPoolFootprintWorldPts(poolGroup);
  if (!poly) return [[alongMin, alongMax]];

  const origin = center.clone().add(axisAcross.clone().multiplyScalar(acrossLocal));
  const ox = origin.x;
  const oy = origin.y;
  const dx = axisAlong.x;
  const dy = axisAlong.y;
  const denomEps = 1e-9;
  const pointEps = 1e-5;
  const rangeEps = 1e-4;

  const tValues = [alongMin, alongMax];

  const addT = (t) => {
    if (!isFinite(t) || t < alongMin - rangeEps || t > alongMax + rangeEps) return;
    const clamped = Math.max(alongMin, Math.min(alongMax, t));
    if (!tValues.some((v) => Math.abs(v - clamped) < 1e-5)) tValues.push(clamped);
  };

  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const det = dx * (-ey) - dy * (-ex);

    if (Math.abs(det) < denomEps) continue;

    const rx = a.x - ox;
    const ry = a.y - oy;
    const t = (rx * (-ey) - ry * (-ex)) / det;
    const u = (dx * ry - dy * rx) / det;
    if (u >= -pointEps && u <= 1 + pointEps) addT(t);
  }

  tValues.sort((a, b) => a - b);

  const sampleOutside = (t) => {
    const p = {
      x: ox + dx * t,
      y: oy + dy * t
    };
    return !isPointInsidePolygon2D(p, poly);
  };

  const intervals = [];
  for (let i = 0; i < tValues.length - 1; i++) {
    const a = tValues[i];
    const b = tValues[i + 1];
    if (b - a <= rangeEps) continue;
    const mid = (a + b) * 0.5;
    if (sampleOutside(mid)) intervals.push([a, b]);
  }

  const startOutside = sampleOutside(alongMin + rangeEps);
  const endOutside = sampleOutside(alongMax - rangeEps);
  if (!intervals.length && (startOutside || endOutside)) return [[alongMin, alongMax]];

  return intervals;
}

function getSpaChannelMargin(spaGroup) {
  if (!spaGroup) return 0;
  spaGroup.updateMatrixWorld?.(true);
  const box = new THREE.Box3().setFromObject(spaGroup);
  return box.max.z > RAISED_SPA_THRESHOLD_Z ? RAISED_SPA_CHANNEL_WALL_OFFSET : 0;
}

function getSpaChannelMargins(spaGroup, poolGroup = null) {
  const channel = getSpaChannelMargin(spaGroup);
  const margins = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  if (!channel) return margins;
  if (!spaGroup || !poolGroup) {
    margins.minX = channel;
    margins.maxX = channel;
    margins.minY = channel;
    margins.maxY = channel;
    return margins;
  }

  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left') {
    margins.minX = channel;
    margins.minY = channel;
    margins.maxY = channel;
    return margins;
  }
  if (snapSide === 'right') {
    margins.maxX = channel;
    margins.minY = channel;
    margins.maxY = channel;
    return margins;
  }
  if (snapSide === 'front') {
    margins.minY = channel;
    margins.minX = channel;
    margins.maxX = channel;
    return margins;
  }
  if (snapSide === 'back') {
    margins.maxY = channel;
    margins.minX = channel;
    margins.maxX = channel;
    return margins;
  }

  spaGroup.updateMatrixWorld?.(true);
  poolGroup.updateMatrixWorld?.(true);

  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);

  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const sampleInset = 0.01;
  const sampleOut = 0.04;

  const isOutsidePool = (point) => !isPointInsidePoolFootprint(poolGroup, point);
  const samplePoint = (ax, dist) => center.clone().add(ax.clone().multiplyScalar(dist));

  if (isOutsidePool(samplePoint(axisX, -(halfX + sampleOut))) || isOutsidePool(samplePoint(axisX, -(halfX - sampleInset)))) margins.minX = channel;
  if (isOutsidePool(samplePoint(axisX, +(halfX + sampleOut))) || isOutsidePool(samplePoint(axisX, +(halfX - sampleInset)))) margins.maxX = channel;
  if (isOutsidePool(samplePoint(axisY, -(halfY + sampleOut))) || isOutsidePool(samplePoint(axisY, -(halfY - sampleInset)))) margins.minY = channel;
  if (isOutsidePool(samplePoint(axisY, +(halfY + sampleOut))) || isOutsidePool(samplePoint(axisY, +(halfY - sampleInset)))) margins.maxY = channel;

  return margins;
}

function getExpandedSpaWorldAABB(spaGroup, margins = null, pad = 0) {
  if (!spaGroup) return null;

  spaGroup.updateMatrixWorld?.(true);

  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);

  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5 + pad);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5 + pad);
  const minX = -halfX - (margins?.minX || 0);
  const maxX =  halfX + (margins?.maxX || 0);
  const minY = -halfY - (margins?.minY || 0);
  const maxY =  halfY + (margins?.maxY || 0);

  const corners = [
    center.clone().add(axisX.clone().multiplyScalar(minX)).add(axisY.clone().multiplyScalar(minY)),
    center.clone().add(axisX.clone().multiplyScalar(minX)).add(axisY.clone().multiplyScalar(maxY)),
    center.clone().add(axisX.clone().multiplyScalar(maxX)).add(axisY.clone().multiplyScalar(minY)),
    center.clone().add(axisX.clone().multiplyScalar(maxX)).add(axisY.clone().multiplyScalar(maxY))
  ];

  const aabb = new THREE.Box3();
  corners.forEach((c) => aabb.expandByPoint(c));
  return { aabb, center, axisX, axisY, minX, maxX, minY, maxY };
}



function getAllPoolCopingMeshes(poolGroup) {
  const copingSegments = poolGroup?.userData?.copingSegments;
  if (!copingSegments) return [];
  if (Array.isArray(copingSegments)) return copingSegments.filter(Boolean);
  if (typeof copingSegments === 'object') return Object.values(copingSegments).filter(Boolean);
  return [];
}

function getSpaPoolWallSamplePoint(poolGroup, spaGroup) {
  if (!spaGroup) return null;
  spaGroup.updateMatrixWorld?.(true);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);
  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left') return center.clone().add(axisX.multiplyScalar(-halfX));
  if (snapSide === 'right') return center.clone().add(axisX.multiplyScalar(halfX));
  if (snapSide === 'front') return center.clone().add(axisY.multiplyScalar(-halfY));
  if (snapSide === 'back') return center.clone().add(axisY.multiplyScalar(halfY));
  return center;
}

function getAdjacentPoolCopingBounds(poolGroup, spaGroup) {
  const copingMeshes = getAllPoolCopingMeshes(poolGroup);
  if (!copingMeshes.length) return null;

  const sample = getSpaPoolWallSamplePoint(poolGroup, spaGroup);
  let best = null;
  let bestDistSq = Infinity;

  for (const mesh of copingMeshes) {
    if (!mesh) continue;
    mesh.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.z) || !isFinite(box.max.z)) continue;

    if (!sample) {
      const zSpan = box.max.z - box.min.z;
      if (!best || zSpan > (best.max.z - best.min.z)) best = box.clone();
      continue;
    }

    const clampedX = Math.max(box.min.x, Math.min(sample.x, box.max.x));
    const clampedY = Math.max(box.min.y, Math.min(sample.y, box.max.y));
    const dx = sample.x - clampedX;
    const dy = sample.y - clampedY;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = box.clone();
    }
  }

  return best;
}

function getPoolCopingUndersideZ(poolGroup, spaGroup) {
  const box = getAdjacentPoolCopingBounds(poolGroup, spaGroup);
  if (box && isFinite(box.min.z)) return box.min.z;
  return -0.05;
}

function getPoolCopingTopZ(poolGroup, spaGroup) {
  const box = getAdjacentPoolCopingBounds(poolGroup, spaGroup);
  if (box && isFinite(box.max.z)) return box.max.z;
  return 0.05;
}

function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse?.((child) => {
    if (child?.geometry) child.geometry.dispose?.();
    const mats = Array.isArray(child?.material) ? child.material : [child?.material];
    mats.forEach((m) => m?.dispose?.());
  });
}

function clearSpaChannelMeshes(ground) {
  const parent = ground?.parent;
  const group = ground?.userData?.spaChannelGroup;
  if (group && parent) parent.remove(group);
  if (group) {
    group.traverse?.((child) => {
      if (child?.geometry && child.geometry !== CHANNEL_UNIT_BOX_GEOMETRY) child.geometry.dispose?.();
    });
    const mats = new Set();
    group.traverse?.((child) => {
      const material = child?.material;
      if (Array.isArray(material)) material.forEach((m) => m && mats.add(m));
      else if (material) mats.add(material);
    });
    mats.forEach((m) => m?.dispose?.());
    group.clear?.();
  }
  if (ground?.userData) ground.userData.spaChannelGroup = null;
}

function createSpaChannelMaterial(spaGroup) {
  const source = spaGroup?.userData?.floor?.material || spaGroup?.userData?.walls?.front?.material || null;
  if (source?.clone) {
    const cloned = source.clone();
    cloned.transparent = false;
    cloned.opacity = 1;
    return cloned;
  }
  return new THREE.MeshStandardMaterial({
    color: 0xa9bcc8,
    roughness: 0.85,
    metalness: 0.0
  });
}

function createCopingRebuildMaterial(poolGroup) {
  const copingSegments = poolGroup?.userData?.copingSegments;
  const source = Array.isArray(copingSegments)
    ? (copingSegments[0]?.material || null)
    : (copingSegments && typeof copingSegments === 'object'
        ? (Object.values(copingSegments).find((m) => m?.material)?.material || null)
        : null);
  if (source?.clone) {
    const cloned = source.clone();
    cloned.transparent = false;
    cloned.opacity = 1;
    return cloned;
  }
  return new THREE.MeshStandardMaterial({
    color: 0xe5e0d8,
    roughness: 0.9,
    metalness: 0.0
  });
}

function getForcedSpaChannelFullSpanSides(spaGroup) {
  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left') return new Set(['minX', 'minY', 'maxY']);
  if (snapSide === 'right') return new Set(['maxX', 'minY', 'maxY']);
  if (snapSide === 'front') return new Set(['minY', 'minX', 'maxX']);
  if (snapSide === 'back') return new Set(['maxY', 'minX', 'maxX']);
  return new Set();
}

const CHANNEL_UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

function getOrCreateSpaChannelGroup(ground) {
  const parent = ground?.parent;
  if (!parent) return null;
  let group = ground?.userData?.spaChannelGroup || null;
  if (!group) {
    group = new THREE.Group();
    group.name = 'SpaChannelGroup';
    group.userData.meshMap = new Map();
    parent.add(group);
    if (ground?.userData) ground.userData.spaChannelGroup = group;
  }
  return group;
}

function beginSpaChannelUpdate(group) {
  if (!group) return;
  group.visible = true;
  group.userData.meshMap = group.userData.meshMap || new Map();
  group.userData.meshMap.forEach((mesh) => { if (mesh) mesh.userData._usedThisPass = false; });
}

function finishSpaChannelUpdate(group) {
  if (!group?.userData?.meshMap) return;
  group.userData.meshMap.forEach((mesh) => {
    if (mesh) mesh.visible = !!mesh.userData._usedThisPass;
  });
}

function addChannelBox(group, key, sizeX, sizeY, sizeZ, localX, localY, center, axisX, axisY, quat, material, zCenter) {
  if (!group || !(sizeX > 1e-4 && sizeY > 1e-4 && sizeZ > 1e-4)) return;
  group.userData.meshMap = group.userData.meshMap || new Map();
  let mesh = group.userData.meshMap.get(key);
  if (!mesh) {
    mesh = new THREE.Mesh(CHANNEL_UNIT_BOX_GEOMETRY, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.isSpaChannel = true;
    group.userData.meshMap.set(key, mesh);
    group.add(mesh);
  }
  if (mesh.material !== material) mesh.material = material;
  const worldPos = center.clone()
    .add(axisX.clone().multiplyScalar(localX))
    .add(axisY.clone().multiplyScalar(localY));
  mesh.position.set(worldPos.x, worldPos.y, zCenter);
  mesh.quaternion.copy(quat);
  mesh.scale.set(sizeX, sizeY, sizeZ);
  mesh.visible = true;
  mesh.userData._usedThisPass = true;
}



function getSharedCopingProfile(poolGroup, spaGroup = null) {
  const meshes = [];
  const copingSegments = poolGroup?.userData?.copingSegments;
  if (Array.isArray(copingSegments)) meshes.push(...copingSegments.filter(Boolean));
  else if (copingSegments && typeof copingSegments === 'object') meshes.push(...Object.values(copingSegments).filter(Boolean));
  const joinGroup = poolGroup?.userData?.spaJoinCopingGroup;
  if (joinGroup?.children?.length) meshes.push(...joinGroup.children.filter(Boolean));
  if (!meshes.length) return null;

  const sample = meshes.find((m) => m?.geometry?.parameters) || meshes[0];
  const params = sample?.geometry?.parameters || {};
  const width = Math.max(0.25, Math.min(
    (params.width || 0) > (params.height || 0) ? (params.height || 0) : (params.width || 0),
    (params.width || 0) > (params.height || 0) ? (params.width || 0) : (params.height || 0)
  ) || 0.25);
  const depth = Math.max(0.02, params.depth || (getPoolCopingTopZ(poolGroup, spaGroup) - getPoolCopingUndersideZ(poolGroup, spaGroup)) || 0.1);
  const topZ = getPoolCopingTopZ(poolGroup, spaGroup);
  const underZ = getPoolCopingUndersideZ(poolGroup, spaGroup);
  return {
    width,
    depth,
    topZ,
    underZ,
    zCenter: underZ + depth * 0.5,
    material: createCopingRebuildMaterial(poolGroup),
  };
}

function clearRectanglePoolSpaJoinCoping(poolGroup) {
  if (!poolGroup) return;
  const joinGroup = poolGroup.userData?.spaJoinCopingGroup || null;
  if (joinGroup) {
    joinGroup.parent?.remove(joinGroup);
    joinGroup.traverse((obj) => {
      if (obj?.geometry) obj.geometry.dispose?.();
    });
    poolGroup.userData.spaJoinCopingGroup = null;
  }

  const copingSegments = poolGroup.userData?.copingSegments;
  if (copingSegments && typeof copingSegments === 'object' && !Array.isArray(copingSegments)) {
    Object.values(copingSegments).forEach((seg) => {
      if (seg) seg.visible = true;
    });
  }
}

function applyRectanglePoolCopingJoin(poolGroup, spaGroup) {
  clearRectanglePoolSpaJoinCoping(poolGroup);
  if (!poolGroup || !spaGroup) return;

  const copingSegments = poolGroup.userData?.copingSegments;
  if (!copingSegments || Array.isArray(copingSegments)) return;

  const sideMap = { left: 'west', right: 'east', front: 'south', back: 'north' };
  const poolSide = sideMap[spaGroup?.userData?.snapSide || ''];
  const original = copingSegments?.[poolSide] || null;
  if (!original?.geometry || !original?.material) return;

  spaGroup.updateMatrixWorld?.(true);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);
  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const margins = getSpaChannelMargins(spaGroup, poolGroup);

  const sharedProfile = getSharedCopingProfile(poolGroup, spaGroup);
  const joinOverlap = 0.005; // 5mm shared-profile overlap for a flush join
  let openingMin = 0;
  let openingMax = 0;
  let axis = 'x';

  if (poolSide === 'north' || poolSide === 'south') {
    const outerHalfX = Math.max(halfX + (margins.minX || 0), halfX + (margins.maxX || 0));
    openingMin = center.x - outerHalfX + joinOverlap;
    openingMax = center.x + outerHalfX - joinOverlap;
    axis = 'x';
  } else {
    const outerHalfY = Math.max(halfY + (margins.minY || 0), halfY + (margins.maxY || 0));
    openingMin = center.y - outerHalfY + joinOverlap;
    openingMax = center.y + outerHalfY - joinOverlap;
    axis = 'y';
  }

  const params = original.geometry.parameters || {};
  const targetCross = Math.max(0.01, sharedProfile?.width || (axis === 'x' ? (params.height || 0) : (params.width || 0)) || 0.25);
  const targetDepth = Math.max(0.02, sharedProfile?.depth || params.depth || 0.1);
  const segLen = axis === 'x' ? (params.width || 0) : (params.height || 0);
  const segCross = targetCross;
  const segDepth = targetDepth;
  if (!(segLen > 1e-4 && segCross > 1e-4 && segDepth > 1e-4)) return;

  const segMin = (axis === 'x' ? original.position.x : original.position.y) - segLen * 0.5;
  const segMax = (axis === 'x' ? original.position.x : original.position.y) + segLen * 0.5;
  const leftEnd = Math.max(segMin, Math.min(segMax, openingMin));
  const rightStart = Math.max(segMin, Math.min(segMax, openingMax));

  const group = new THREE.Group();
  group.name = 'SpaJoinCopingGroup';

  const makePiece = (a, b) => {
    const len = b - a;
    if (!(len > 1e-4)) return;
    const geo = axis === 'x'
      ? new THREE.BoxGeometry(len, segCross, segDepth)
      : new THREE.BoxGeometry(segCross, len, segDepth);
    if (geo.attributes && geo.attributes.uv && !geo.attributes.uv2) {
      geo.setAttribute('uv2', new THREE.BufferAttribute(geo.attributes.uv.array, 2));
    }
    const mesh = new THREE.Mesh(geo, original.material.clone ? original.material.clone() : original.material);
    mesh.position.copy(original.position);
    if (axis === 'x') mesh.position.x = (a + b) * 0.5;
    else mesh.position.y = (a + b) * 0.5;
    mesh.quaternion.copy(original.quaternion);
    mesh.castShadow = original.castShadow;
    mesh.receiveShadow = original.receiveShadow;
    mesh.userData = { ...original.userData, isSpaJoinReplacement: true, baseZ: original.userData?.baseZ ?? mesh.position.z };
    group.add(mesh);
  };

  const makeWrapPiece = (edge, dir) => {
    const geo = axis === 'x'
      ? new THREE.BoxGeometry(segCross, segCross, segDepth)
      : new THREE.BoxGeometry(segCross, segCross, segDepth);
    if (geo.attributes && geo.attributes.uv && !geo.attributes.uv2) {
      geo.setAttribute('uv2', new THREE.BufferAttribute(geo.attributes.uv.array, 2));
    }
    const mesh = new THREE.Mesh(geo, original.material.clone ? original.material.clone() : original.material);
    mesh.position.copy(original.position);
    if (axis === 'x') mesh.position.x = edge + dir * segCross * 0.5;
    else mesh.position.y = edge + dir * segCross * 0.5;
    mesh.quaternion.copy(original.quaternion);
    mesh.castShadow = original.castShadow;
    mesh.receiveShadow = original.receiveShadow;
    mesh.userData = { ...original.userData, isSpaJoinWrap: true, baseZ: original.userData?.baseZ ?? mesh.position.z };
    group.add(mesh);
  };

  makePiece(segMin, leftEnd);
  makePiece(rightStart, segMax);
  makeWrapPiece(openingMin, -1);
  makeWrapPiece(openingMax, 1);

  if (!group.children.length) return;

  original.visible = false;
  poolGroup.add(group);
  poolGroup.userData.spaJoinCopingGroup = group;
}

function updateSpaChannelMeshes(ground, poolGroup, spaGroup) {
  if (!ground || !poolGroup || !spaGroup) {
    clearSpaChannelMeshes(ground);
    clearRectanglePoolSpaJoinCoping(poolGroup);
    return;
  }

  const margins = getSpaChannelMargins(spaGroup, poolGroup);
  if (!(margins.minX > 0 || margins.maxX > 0 || margins.minY > 0 || margins.maxY > 0)) {
    clearSpaChannelMeshes(ground);
    clearRectanglePoolSpaJoinCoping(poolGroup);
    return;
  }

  spaGroup.updateMatrixWorld?.(true);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);
  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);

  const minX = -halfX - (margins.minX || 0);
  const maxX =  halfX + (margins.maxX || 0);
  const minY = -halfY - (margins.minY || 0);
  const maxY =  halfY + (margins.maxY || 0);

  const sharedCoping = getSharedCopingProfile(poolGroup, spaGroup);
  const copingUnderZ = sharedCoping?.underZ ?? getPoolCopingUndersideZ(poolGroup, spaGroup);
  const copingTopZ = sharedCoping?.topZ ?? getPoolCopingTopZ(poolGroup, spaGroup);
  const copingDepth = Math.max(0.05, sharedCoping?.depth ?? (copingTopZ - copingUnderZ));
  const channelFloorTopZ = copingTopZ - 0.3;
  const channelFloorThickness = 0.02;
  const wallHeight = Math.max(0.02, copingUnderZ - channelFloorTopZ);
  const wallThickness = 0.20;
  const copingRebuildWidth = Math.max(0.25, sharedCoping?.width || 0.25);

  const group = getOrCreateSpaChannelGroup(ground);
  beginSpaChannelUpdate(group);
  const mat = createSpaChannelMaterial(spaGroup);
  const copingMat = sharedCoping?.material || createCopingRebuildMaterial(poolGroup);

  const floorZCenter = channelFloorTopZ - channelFloorThickness * 0.5;
  const wallZCenter = channelFloorTopZ + wallHeight * 0.5;
  const copingZCenter = sharedCoping?.zCenter ?? (copingUnderZ + copingDepth * 0.5);
  const snapSide = spaGroup?.userData?.snapSide || null;
  const returnLen = copingRebuildWidth;
  const intervalEps = 1e-4;
  const getSideIntervals = (_sideKey, axisAlong, axisAcross, stripCenter, alongMin, alongMax) => {
    return getOutsideIntervalsAlongSide(center, axisAlong, axisAcross, stripCenter, alongMin, alongMax, poolGroup);
  };

  let channelPieceIndex = 0;
  const addFloorStrip = (sx, sy, lx, ly) => {
    addChannelBox(group, `floor-${channelPieceIndex++}`, sx, sy, channelFloorThickness, lx, ly, center, axisX, axisY, quat, mat, floorZCenter);
  };
  const addWallStrip = (sx, sy, lx, ly) => {
    addChannelBox(group, `wall-${channelPieceIndex++}`, sx, sy, wallHeight, lx, ly, center, axisX, axisY, quat, mat, wallZCenter);
  };
  const addCopingStrip = (sx, sy, lx, ly) => {
    addChannelBox(group, `coping-${channelPieceIndex++}`, sx, sy, copingDepth, lx, ly, center, axisX, axisY, quat, copingMat, copingZCenter);
  };

  if (margins.minX > 0) {
    const wallInnerX = minX + wallThickness;
    const floorWidth = Math.max(0.01, (-halfX) - wallInnerX);
    const floorCenterX = (wallInnerX + (-halfX)) * 0.5;
    const stripCenterX = -halfX - margins.minX * 0.5;
    const wallX = minX + wallThickness * 0.5;
    const copingX = minX + copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('minX', axisY, axisX, stripCenterX, minY, maxY);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(floorWidth, span, floorCenterX, mid);
      addWallStrip(wallThickness, span, wallX, mid);
      addCopingStrip(copingRebuildWidth, span, copingX, mid);
      if (snapSide === 'left') {
        if (a > minY + intervalEps) {
          const len = Math.min(returnLen, a - minY);
          addWallStrip(wallThickness, len, wallX, a - len * 0.5);
          addCopingStrip(copingRebuildWidth, len, copingX, a - len * 0.5);
        }
        if (b < maxY - intervalEps) {
          const len = Math.min(returnLen, maxY - b);
          addWallStrip(wallThickness, len, wallX, b + len * 0.5);
          addCopingStrip(copingRebuildWidth, len, copingX, b + len * 0.5);
        }
      }
    });
  }
  if (margins.maxX > 0) {
    const wallInnerX = maxX - wallThickness;
    const floorWidth = Math.max(0.01, wallInnerX - halfX);
    const floorCenterX = (wallInnerX + halfX) * 0.5;
    const stripCenterX = halfX + margins.maxX * 0.5;
    const wallX = maxX - wallThickness * 0.5;
    const copingX = maxX - copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('maxX', axisY, axisX, stripCenterX, minY, maxY);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(floorWidth, span, floorCenterX, mid);
      addWallStrip(wallThickness, span, wallX, mid);
      addCopingStrip(copingRebuildWidth, span, copingX, mid);
      if (snapSide === 'left') {
        if (a > minY + intervalEps) {
          const len = Math.min(returnLen, a - minY);
          addWallStrip(wallThickness, len, wallX, a - len * 0.5);
          addCopingStrip(copingRebuildWidth, len, copingX, a - len * 0.5);
        }
        if (b < maxY - intervalEps) {
          const len = Math.min(returnLen, maxY - b);
          addWallStrip(wallThickness, len, wallX, b + len * 0.5);
          addCopingStrip(copingRebuildWidth, len, copingX, b + len * 0.5);
        }
      }
    });
  }
  if (margins.minY > 0) {
    const wallInnerY = minY + wallThickness;
    const floorWidth = Math.max(0.01, (-halfY) - wallInnerY);
    const floorCenterY = (wallInnerY + (-halfY)) * 0.5;
    const stripCenterY = -halfY - margins.minY * 0.5;
    const wallY = minY + wallThickness * 0.5;
    const copingY = minY + copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('minY', axisX, axisY, stripCenterY, minX, maxX);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(span, floorWidth, mid, floorCenterY);
      addWallStrip(span, wallThickness, mid, wallY);
      addCopingStrip(span, copingRebuildWidth, mid, copingY);
      if (snapSide === 'front') {
        if (a > minX + intervalEps) {
          const len = Math.min(returnLen, a - minX);
          addWallStrip(len, wallThickness, a - len * 0.5, wallY);
          addCopingStrip(len, copingRebuildWidth, a - len * 0.5, copingY);
        }
        if (b < maxX - intervalEps) {
          const len = Math.min(returnLen, maxX - b);
          addWallStrip(len, wallThickness, b + len * 0.5, wallY);
          addCopingStrip(len, copingRebuildWidth, b + len * 0.5, copingY);
        }
      }
    });
  }
  if (margins.maxY > 0) {
    const wallInnerY = maxY - wallThickness;
    const floorWidth = Math.max(0.01, wallInnerY - halfY);
    const floorCenterY = (wallInnerY + halfY) * 0.5;
    const stripCenterY = halfY + margins.maxY * 0.5;
    const wallY = maxY - wallThickness * 0.5;
    const copingY = maxY - copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('maxY', axisX, axisY, stripCenterY, minX, maxX);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(span, floorWidth, mid, floorCenterY);
      addWallStrip(span, wallThickness, mid, wallY);
      addCopingStrip(span, copingRebuildWidth, mid, copingY);
      if (snapSide === 'front') {
        if (a > minX + intervalEps) {
          const len = Math.min(returnLen, a - minX);
          addWallStrip(len, wallThickness, a - len * 0.5, wallY);
          addCopingStrip(len, copingRebuildWidth, a - len * 0.5, copingY);
        }
        if (b < maxX - intervalEps) {
          const len = Math.min(returnLen, maxX - b);
          addWallStrip(len, wallThickness, b + len * 0.5, wallY);
          addCopingStrip(len, copingRebuildWidth, b + len * 0.5, copingY);
        }
      }
    });
  }

  finishSpaChannelUpdate(group);
  applyRectanglePoolCopingJoin(poolGroup, spaGroup);
}

function ensureGroundSpaClipMaterial(ground) {
  const mat = ground?.material;
  if (!mat || mat.userData?.spaClipPatched) return;

  mat.userData.spaClipPatched = true;
  mat.userData.spaClipUniforms = {
    spaClipEnabled: { value: 0 },
    spaClipCenter: { value: new THREE.Vector3() },
    spaClipAxisX: { value: new THREE.Vector3(1, 0, 0) },
    spaClipAxisY: { value: new THREE.Vector3(0, 1, 0) },
    spaClipHalfSize: { value: new THREE.Vector2(0.5, 0.5) }
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.spaClipUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vSpaClipWorldPos;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vSpaClipWorldPos = worldPosition.xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vSpaClipWorldPos;
         uniform int spaClipEnabled;
         uniform vec3 spaClipCenter;
         uniform vec3 spaClipAxisX;
         uniform vec3 spaClipAxisY;
         uniform vec2 spaClipHalfSize;`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if (spaClipEnabled == 1) {
           vec3 d = vSpaClipWorldPos - spaClipCenter;
           float lx = dot(d, normalize(spaClipAxisX));
           float ly = dot(d, normalize(spaClipAxisY));
           if (abs(lx) <= spaClipHalfSize.x && abs(ly) <= spaClipHalfSize.y) discard;
         }`
      );
  };

  mat.customProgramCacheKey = () => 'ground-spa-clip-v2';
  mat.needsUpdate = true;
}

function updateGroundMaterialSpaClip(ground, spaGroup = null, poolGroup = null) {
  const mat = ground?.material;
  const uniforms = mat?.userData?.spaClipUniforms;
  if (!uniforms) return;

  if (!spaGroup) {
    uniforms.spaClipEnabled.value = 0;
    return;
  }

  spaGroup.updateMatrixWorld?.(true);
  const box = new THREE.Box3().setFromObject(spaGroup);
  const minZ = box.min.z;
  const maxZ = box.max.z;
  const groundZ = ground?.position?.z ?? 0;

  if (!(minZ <= groundZ + 0.02 && maxZ >= groundZ - 0.02)) {
    uniforms.spaClipEnabled.value = 0;
    return;
  }

  const pad = 0.0;
  const margins = getGroundSpaClipMargins(spaGroup, poolGroup);
  const expanded = getExpandedSpaWorldAABB(spaGroup, margins, pad);
  if (!expanded) {
    uniforms.spaClipEnabled.value = 0;
    return;
  }

  const offsetX = (expanded.maxX + expanded.minX) * 0.5;
  const offsetY = (expanded.maxY + expanded.minY) * 0.5;
  const clipCenter = expanded.center.clone()
    .add(expanded.axisX.clone().multiplyScalar(offsetX))
    .add(expanded.axisY.clone().multiplyScalar(offsetY));
  const halfX = Math.max(0.01, (expanded.maxX - expanded.minX) * 0.5);
  const halfY = Math.max(0.01, (expanded.maxY - expanded.minY) * 0.5);

  uniforms.spaClipEnabled.value = 1;
  uniforms.spaClipCenter.value.copy(clipCenter);
  uniforms.spaClipAxisX.value.copy(expanded.axisX);
  uniforms.spaClipAxisY.value.copy(expanded.axisY);
  uniforms.spaClipHalfSize.value.set(halfX, halfY);
}

export async function initScene() {
  const container = document.getElementById("three-root") || document.body;

  const scene = new THREE.Scene();

  // IMPORTANT: Do NOT touch THREE.Object3D.DEFAULT_UP here.
  // Your app already has an established axis convention; changing DEFAULT_UP will flip everything.
  // We only set camera.up to match the rest of your app (Z-up in your pool code).
  const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    500
  );
  camera.up.set(0, 0, 1);
  camera.position.set(12, -16, 10);
  camera.lookAt(0, 0, 0);
  scene.userData.camera = camera;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  // Modern color pipeline + PBR-friendly tone mapping
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95; // slightly lower to reduce washed-out grass
  container.appendChild(renderer.domElement);

  // -------------------------
  // Lighting: key/fill/rim
  // -------------------------
  const ambient = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(ambient);

  dirLight = new THREE.DirectionalLight(0xffffff, 2.8);
  dirLight.position.set(18, -22, 30);
  dirLight.castShadow = true;

  // If you want extra FPS, drop to 1024:
  // dirLight.shadow.mapSize.set(1024, 1024);
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.normalBias = 0.02;
  dirLight.shadow.bias = -0.0002;

  const d = 20;
  dirLight.shadow.camera = new THREE.OrthographicCamera(-d, d, d, -d, 0.5, 150);
  scene.add(dirLight);
  scene.add(dirLight.target);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
  fillLight.position.set(-20, 20, 18);
  fillLight.castShadow = false;
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.55);
  rimLight.position.set(25, 25, 12);
  rimLight.castShadow = false;
  scene.add(rimLight);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.target.set(0, 0, 0);
  controls.update();
  scene.userData.controls = controls;

  // -------------------------
  // Ground plane
  // NOTE: Your app cuts the void using updateGroundVoid(). Keep this mesh stable.
  // -------------------------
  const groundGeo = new THREE.PlaneGeometry(200, 200, 1, 1);

  // -------------------------
  // Ground material: Studio floor (neutral, slightly rough)
  // Keep this mesh stable: updateGroundVoid() will replace the geometry to cut the pool footprint hole.
  // -------------------------
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xf3f5f7,
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.25
  });

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(0, 0, 0);
  ground.receiveShadow = true;
  ensureGroundSpaClipMaterial(ground);
  scene.add(ground);
  scene.userData.ground = ground;

  // -------------------------
  // Studio environment (no external HDRI): neutral reflections + soft ambient feel
  // -------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // -------------------------
  // Background: subtle vertical gradient sky-dome (clean showroom look)
  // -------------------------
  const skyGeo = new THREE.SphereGeometry(500, 48, 32);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0xf7f9fc) },
      bottomColor: { value: new THREE.Color(0xe7edf5) }
    },
    vertexShader: `
      varying vec3 vPos;
      void main(){
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      void main(){
        float h = normalize(vPos).y * 0.5 + 0.5;
        h = smoothstep(0.0, 1.0, h);
        gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
      }
    `
  });

  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.frustumCulled = false;
  skyDome.onBeforeRender = (_r, _s, cam) => {
    skyDome.position.copy(cam.position);
  };

  // Remove any previous background objects
  if (scene.userData.skyDome) {
    scene.remove(scene.userData.skyDome);
    scene.userData.skyDome.geometry.dispose();
    scene.userData.skyDome.material.dispose();
  }
  scene.add(skyDome);
  scene.userData.skyDome = skyDome;

  // Background is provided by geometry
  scene.background = null;

  // Resize
  window.addEventListener("resize", () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  });

  return { scene, camera, renderer, ground, controls };
}

// --------------------------------------------------------
// Ground void update (cut footprint hole)
// --------------------------------------------------------
export function updateGroundVoid(ground, poolGroup, spaGroup = null) {
  if (!ground || !poolGroup || !poolGroup.userData || !poolGroup.userData.outerPts) return;

  ensureGroundSpaClipMaterial(ground);

  const voidKey = getGroundVoidCacheKey(poolGroup);
  const clipKey = getSpaClipCacheKey(spaGroup, poolGroup);
  const channelKey = getSpaChannelCacheKey(spaGroup, poolGroup);
  const shadowKey = `${voidKey}::${_r3(poolGroup.position?.x || 0)},${_r3(poolGroup.position?.y || 0)},${_r3(poolGroup.position?.z || 0)}::${_r3(poolGroup.scale?.x || 1)},${_r3(poolGroup.scale?.y || 1)},${_r3(poolGroup.scale?.z || 1)}`;

  if (ground.userData?.groundVoidKey !== voidKey) {
    const outerPts = poolGroup.userData.outerPts;

    // Apply poolGroup transform (so live preview scaling updates the void correctly)
    const sx = (poolGroup.scale && isFinite(poolGroup.scale.x)) ? poolGroup.scale.x : 1;
    const sy = (poolGroup.scale && isFinite(poolGroup.scale.y)) ? poolGroup.scale.y : 1;
    const px = (poolGroup.position && isFinite(poolGroup.position.x)) ? poolGroup.position.x : 0;
    const py = (poolGroup.position && isFinite(poolGroup.position.y)) ? poolGroup.position.y : 0;

    const holePts = outerPts.map((v) => new THREE.Vector2(v.x * sx + px, v.y * sy + py));

    const groundShape = new THREE.Shape([
      new THREE.Vector2(-100, -100),
      new THREE.Vector2(100, -100),
      new THREE.Vector2(100, 100),
      new THREE.Vector2(-100, 100)
    ]);

    groundShape.holes = [new THREE.Path(holePts)];

    const newGeo = new THREE.ShapeGeometry(groundShape);
    ground.geometry.dispose();
    ground.geometry = newGeo;
    if (ground.userData) ground.userData.groundVoidKey = voidKey;
  }

  if (ground.userData?.groundSpaClipKey !== clipKey) {
    updateGroundMaterialSpaClip(ground, spaGroup, poolGroup);
    if (ground.userData) ground.userData.groundSpaClipKey = clipKey;
  }

  if (ground.userData?.groundSpaChannelKey !== channelKey) {
    updateSpaChannelMeshes(ground, poolGroup, spaGroup);
    if (ground.userData) ground.userData.groundSpaChannelKey = channelKey;
  }

  if (ground.userData?.groundShadowKey !== shadowKey) {
    updateShadowBounds(poolGroup);
    if (ground.userData) ground.userData.groundShadowKey = shadowKey;
  }
}


// --------------------------------------------------------
// Update directional light shadow box to fit pool
// --------------------------------------------------------
export function updateShadowBounds(poolGroup) {
  if (!dirLight || !poolGroup) return;

  const box = new THREE.Box3().setFromObject(poolGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const cam = dirLight.shadow.camera;

  // Expand a bit so wall shadows look stable and don't clip while orbiting
  const pad = 6;
  cam.left = -(size.x / 1.4 + pad);
  cam.right = (size.x / 1.4 + pad);
  cam.top = (size.y / 1.4 + pad);
  cam.bottom = -(size.y / 1.4 + pad);

  cam.near = 0.5;
  cam.far = size.z + 120;
  cam.updateProjectionMatrix();

  dirLight.target.position.copy(center);
  dirLight.target.updateMatrixWorld();
}

// --------------------------------------------------------
// Update spa void uniforms on water shader
// and clip any pool geometry that passes through the spa volume.
// --------------------------------------------------------
function getSpaWallThroatClipBox(poolGroup, spaGroup, pad = 0.01) {
  if (!poolGroup || !spaGroup) return null;

  const bounds = getPoolFootprintBoundsWorld(poolGroup);
  if (!bounds) return null;

  spaGroup.updateMatrixWorld?.(true);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const snapSide = spaGroup?.userData?.snapSide || null;

  // Only cut the actual throat/opening through the pool wall.
  // Do not use the full expanded catchment AABB here, or the wall gets
  // over-voided around the tank and exposes gaps/light leaks.
  const insidePad = 0.03 + pad;
  const outsideDepth = 0.28 + pad;
  const alongPad = 0.02 + pad;

  let minX = center.x - halfX - alongPad;
  let maxX = center.x + halfX + alongPad;
  let minY = center.y - halfY - alongPad;
  let maxY = center.y + halfY + alongPad;

  if (snapSide === 'left') {
    minX = bounds.minX - outsideDepth;
    maxX = bounds.minX + insidePad;
  } else if (snapSide === 'right') {
    minX = bounds.maxX - insidePad;
    maxX = bounds.maxX + outsideDepth;
  } else if (snapSide === 'front') {
    minY = bounds.minY - outsideDepth;
    maxY = bounds.minY + insidePad;
  } else if (snapSide === 'back') {
    minY = bounds.maxY - insidePad;
    maxY = bounds.maxY + outsideDepth;
  } else {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

export function updatePoolWaterVoid(poolGroup, spaGroup) {
  if (!poolGroup) return;

  const poolWater = poolGroup.userData?.waterMesh || null;
  const mat = poolWater?.material || null;
  const uniforms = mat ? mat.uniforms : null;

  const applyClipToMaterial = (material, planes) => {
    if (!material) return;
    material.clippingPlanes = planes;
    material.clipIntersection = !!planes?.length;
    material.needsUpdate = true;
  };

  const updatePoolGeometryClip = (spa) => {
    if (!poolGroup) return;

    let planes = null;
    if (spa) {
      const sz = spa.position.z;
      const sh = Math.max(0.01, spa.userData?.height || 0.01);
      const pad = 0.01;
      const clipBox = getSpaWallThroatClipBox(poolGroup, spa, pad);
      if (!clipBox) return;

      const { minX, maxX, minY, maxY } = clipBox;
      const poolTopZ = getPoolCopingTopZ(poolGroup, spa) ?? 0.0;
      const wallVoidDepth = 0.30; // only void the first 300mm down from pool top
      const minZ = poolTopZ - wallVoidDepth - pad;
      const maxZ = Math.max(poolTopZ + pad, sz + sh * 0.5 + pad);

      // With clipIntersection=true, fragments inside this box are removed.
      planes = [
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), minX),
        new THREE.Plane(new THREE.Vector3( 1, 0, 0), -maxX),
        new THREE.Plane(new THREE.Vector3( 0,-1, 0), minY),
        new THREE.Plane(new THREE.Vector3( 0, 1, 0), -maxY),
        new THREE.Plane(new THREE.Vector3( 0, 0,-1), minZ),
        new THREE.Plane(new THREE.Vector3( 0, 0, 1), -maxZ)
      ];
    }

    poolGroup.traverse((obj) => {
      if (!obj?.isMesh) return;
      if (obj === poolWater) return;
      if (obj.userData?.isSpaWater) return;
      if (obj.userData?.waterUniforms) return;
      if (typeof obj.userData?.setSimParams === "function") return;

      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => applyClipToMaterial(m, planes));
    });
  };

  // Clear void if no spa provided
  if (!spaGroup) {
    if (uniforms?.spaSize?.value) uniforms.spaSize.value.set(0, 0);
    if (uniforms?.spaRadius) uniforms.spaRadius.value = 0.0;
    updatePoolGeometryClip(null);
    return;
  }

  // World-space bounds (shader uses vWorld.xy)
  const spaBoxWorld = new THREE.Box3().setFromObject(spaGroup);
  const spaCenterWorld = spaBoxWorld.getCenter(new THREE.Vector3());
  const spaSizeWorld = spaBoxWorld.getSize(new THREE.Vector3());

  // Small padding so the cutout doesn't clip the spa walls
  const pad = 0.05;

  if (uniforms?.spaCenter?.value) uniforms.spaCenter.value.set(spaCenterWorld.x, spaCenterWorld.y);
  if (uniforms?.spaSize?.value) uniforms.spaSize.value.set(spaSizeWorld.x + pad, spaSizeWorld.y + pad);

  // Rounded void + edge polish tuning (meters)
  if (uniforms?.spaRadius) {
    const r = 0.15 * Math.min(spaSizeWorld.x, spaSizeWorld.y);
    uniforms.spaRadius.value = Math.max(
      0.0,
      Math.min(r, Math.min(spaSizeWorld.x, spaSizeWorld.y) * 0.5)
    );
  }
  if (uniforms?.spaFeather) uniforms.spaFeather.value = 0.03;
  if (uniforms?.spaEdgeWidth) uniforms.spaEdgeWidth.value = 0.08;
  if (uniforms?.spaEdgeFoam) uniforms.spaEdgeFoam.value = 0.55;
  if (uniforms?.spaEdgeDarken) uniforms.spaEdgeDarken.value = 0.25;

  updatePoolGeometryClip(spaGroup);
}

// --------------------------------------------------------
// Rebuild grass overlay after pool rebuild
// --------------------------------------------------------
export function updateGrassForPool(scene, poolGroup) {
  // Instanced grass removed — keep function for compatibility with PoolApp
  return;
}
// OPTION A: joined coping
