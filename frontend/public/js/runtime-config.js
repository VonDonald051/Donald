'use strict';
// Set window.CONVEX_API_BASE_URL before this file when the frontend is deployed
// separately. A meta tag also supports static hosts. Empty preserves same-origin
// Node development until the Convex API cutover is complete.
const convexApiMeta = document.querySelector('meta[name="convex-api-base"]');
window.API_BASE_URL = window.API_BASE_URL || window.CONVEX_API_BASE_URL || convexApiMeta?.content || '';
