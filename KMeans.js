// kmeans — K-means clustering used by stock monitoring.

export function kMeansCluster(points, k, maxIterations = 50) {
  if (points.length === 0) return { assignments: [], centroids: [] };

  if (points.length <= k) {
    return {
      assignments: points.map((_, i) => i),
      centroids: points.map((p) => [...p])
    };
  }

  let centroids = initializeCentroids(points, k);
  let assignments = new Array(points.length).fill(0);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;

    for (let i = 0; i < points.length; i++) {
      const nearest = nearestCentroidIndex(points[i], centroids);
      if (assignments[i] !== nearest) changed = true;
      assignments[i] = nearest;
    }

    centroids = recomputeCentroids(points, assignments, centroids, k);

    if (!changed) break; // converged — assignments are stable
  }

  return { assignments, centroids };
}

function initializeCentroids(points, k) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const centroids = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.min(
      Math.floor(((i + 0.5) / k) * sorted.length),
      sorted.length - 1
    );
    centroids.push([...sorted[idx]]);
  }
  return centroids;
}

function nearestCentroidIndex(point, centroids) {
  let minDist = Infinity;
  let nearest = 0;
  centroids.forEach((centroid, i) => {
    const dist = euclideanDistance(point, centroid);
    if (dist < minDist) {
      minDist = dist;
      nearest = i;
    }
  });
  return nearest;
}

function euclideanDistance(a, b) {
  return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0));
}

function recomputeCentroids(points, assignments, oldCentroids, k) {
  const dims = points[0].length;
  const sums = Array.from({ length: k }, () => new Array(dims).fill(0));
  const counts = new Array(k).fill(0);

  points.forEach((point, i) => {
    const cluster = assignments[i];
    counts[cluster] += 1;
    point.forEach((val, d) => { sums[cluster][d] += val; });
  });

  return sums.map((sum, cluster) =>
    counts[cluster] > 0
      ? sum.map((total) => total / counts[cluster])
      : oldCentroids[cluster] // empty cluster — keep its previous center rather than snapping to origin
  );
}

export function normalizeFeatures(points) {
  if (points.length === 0) return [];
  const dims = points[0].length;
  const mins = new Array(dims).fill(Infinity);
  const maxs = new Array(dims).fill(-Infinity);

  points.forEach((point) => {
    point.forEach((val, d) => {
      if (val < mins[d]) mins[d] = val;
      if (val > maxs[d]) maxs[d] = val;
    });
  });

  return points.map((point) =>
    point.map((val, d) => {
      const range = maxs[d] - mins[d];
      return range === 0 ? 0 : (val - mins[d]) / range;
    })
  );
}
