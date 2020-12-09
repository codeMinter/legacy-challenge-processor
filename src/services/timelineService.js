/**
 * Timeline Service
 * Interacts with InformixDB
 */
const logger = require('../common/logger')
const util = require('util')
const helper = require('../common/helper')

const QUERY_GET_PHASE_TYPES = 'SELECT phase_type_id, name FROM phase_type_lu'
const QUERY_GET_CHALLENGE_PHASES = 'SELECT project_phase_id, scheduled_start_time, scheduled_end_time, duration, phase_status_id, phase_type_id FROM project_phase WHERE project_id = %d'
const QUERY_UPDATE_CHALLENGE_PHASE = 'UPDATE project_phase SET scheduled_start_time = ?, scheduled_end_time = ?, duration = ?, phase_status_id = ? WHERE project_phase_id = %d and project_id = %d'
const QUERY_ENABLE_TIMELINE_NOTIFICATIONS = 'INSERT INTO project_info (project_id, project_info_type_id, value, create_user, create_date, modify_user, modify_date) VALUES (?, "11", "On", ?, CURRENT, ?, CURRENT)'

/**
 * Prepare Informix statement
 * @param {Object} connection the Informix connection
 * @param {String} sql the sql
 * @return {Object} Informix statement
 */
async function prepare (connection, sql) {
  // logger.debug(`Preparing SQL ${sql}`)
  const stmt = await connection.prepareAsync(sql)
  return Promise.promisifyAll(stmt)
}

/**
 * Gets the phase types from ifx
 */
async function getPhaseTypes () {
  const connection = await helper.getInformixConnection()
  let result = null
  try {
    result = await connection.queryAsync(QUERY_GET_PHASE_TYPES)
  } catch (e) {
    logger.error(`Error in 'getPhaseTypes' ${e}`)
    throw e
  } finally {
    await connection.closeAsync()
  }
  return result
}

/**
 * Gets the challenge phases from ifx
 * @param {Number} challengeLegacyId the legacy challenge ID
 */
async function getChallengePhases (challengeLegacyId) {
  const connection = await helper.getInformixConnection()
  let result = null
  try {
    result = await connection.queryAsync(util.format(QUERY_GET_CHALLENGE_PHASES, challengeLegacyId))
  } catch (e) {
    logger.error(`Error in 'getChallengePhases' ${e}`)
    throw e
  } finally {
    await connection.closeAsync()
  }
  return result
}

/**
 * Update a phase in IFX
 * @param {Number} phaseId the phase ID
 * @param {Number} challengeLegacyId the legacy challenge ID
 * @param {Date} startTime the scheduled start date
 * @param {Date} endTime the scheduled end date
 * @param {Date} duration the duration
 * @param {Number} statusTypeId the status type ID
 */
async function updatePhase (phaseId, challengeLegacyId, startTime, endTime, duration, statusTypeId) {
  const connection = await helper.getInformixConnection()
  let result = null
  try {
    // await connection.beginTransactionAsync()
    const query = await prepare(connection, util.format(QUERY_UPDATE_CHALLENGE_PHASE, phaseId, challengeLegacyId))
    result = await query.executeAsync([startTime, endTime, duration, statusTypeId])
    // await connection.commitTransactionAsync()
  } catch (e) {
    logger.error(`Error in 'updatePhase' ${e}, rolling back transaction`)
    await connection.rollbackTransactionAsync()
    throw e
  } finally {
    logger.info(`Phase ${phaseId} has been updated`)
    await connection.closeAsync()
  }
  return result
}

/**
 * Enable timeline notifications
 * @param {Number} challengeLegacyId the legacy challenge ID
 * @param {String} createdBy the created by
 */
async function enableTimelineNotifications (challengeLegacyId, createdBy) {
  const connection = await helper.getInformixConnection()
  let result = null
  try {
    // await connection.beginTransactionAsync()
    const query = await prepare(connection, QUERY_ENABLE_TIMELINE_NOTIFICATIONS)
    result = await query.executeAsync([challengeLegacyId, createdBy, createdBy])
    // await connection.commitTransactionAsync()
  } catch (e) {
    logger.error(`Error in 'enableTimelineNotifications' ${e}, rolling back transaction`)
    await connection.rollbackTransactionAsync()
    throw e
  } finally {
    logger.info(`Notifications have been enabled for challenge ${challengeLegacyId}`)
    await connection.closeAsync()
  }
  return result
}

module.exports = {
  getChallengePhases,
  getPhaseTypes,
  updatePhase,
  enableTimelineNotifications
}
