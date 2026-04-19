/**
 * Evento Module - Main Router
 *
 * Combines all evento-related routes:
 * - /events - CRUD + bulk creation
 * - /dashboard - Management dashboard (slots, rooms, pending)
 * - /applications - Scheduling (availability, upsert, manual)
 * - /monitor - Fiscalização (exam monitoring)
 * - /reports - Occurrence reports
 */

const express = require('express');
const router = express.Router();

const eventsRoutes = require('./events');
const dashboardRoutes = require('./dashboard');
const applicationsRoutes = require('./applications');
const monitorRoutes = require('./monitor');
const reportsRoutes = require('./reports');

// Event management (admin)
router.use('/events', eventsRoutes);

// Dashboard (admin)
router.use('/dashboard', dashboardRoutes);

// Application scheduling (public + admin)
router.use('/applications', applicationsRoutes);

// Monitor - Fiscalização (admin)
router.use('/monitor', monitorRoutes);

// Reports - Occurrence management (admin)
router.use('/reports', reportsRoutes);

module.exports = router;
