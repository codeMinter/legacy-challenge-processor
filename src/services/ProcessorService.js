/**
 * Processor Service
 * Processes messages gathered from Kafka
 * Interacts with the V4 api for feeding data into legacy system
 */

const _ = require('lodash')
const Joi = require('@hapi/joi')
const config = require('config')
const logger = require('../common/logger')
const helper = require('../common/helper')
const constants = require('../constants')
const showdown = require('showdown')
const converter = new showdown.Converter()

/**
 * Get technologies from V4 API
 * @param {String} m2mToken token for accessing the API
 * @returns {Object} technologies response body
 */
async function getTechnologies (m2mToken) {
  const response = await helper.getRequest(`${config.V4_TECHNOLOGIES_API_URL}`, m2mToken)
  return response.body
}

/**
 * Get platforms from V4 API
 * @param {String} m2mToken token for accessing the API
 * @returns {Object} platforms response body
 */
async function getPlatforms (m2mToken) {
  const response = await helper.getRequest(`${config.V4_PLATFORMS_API_URL}`, m2mToken)
  return response.body
}

/**
 * Get Challenge from V4 API
 * @param {String} m2mToken token for accessing the API
 * @param {Number} legacyId token for accessing the API
 * @returns {Object} challenge response body
 */
async function getChallengeById (m2mToken, legacyId) {
  const response = await helper.getRequest(`${config.V4_CHALLENGE_API_URL}/${legacyId}`, m2mToken)
  return _.get(response, 'body.result.content')
}

/**
 * Get Project from V5 API
 * @param {String} m2mToken token for accessing the API
 * @param {Number} projectId project id
 * @returns {Object} project response body
 */
async function getDirectProjectId (m2mToken, projectId) {
  const response = await helper.getRequest(`${config.V5_PROJECTS_API_URL}/${projectId}`, m2mToken)
  return response.body
}

/**
 * Construct DTO from Kafka message payload.
 * @param {Object} payload the Kafka message payload
 * @param {String} m2mToken the m2m token
 * @param {Boolean} isCreated flag indicate the DTO is used in creating challenge
 * @returns the DTO for saving a draft contest.(refer SaveDraftContestDTO in ap-challenge-microservice)
 */
async function parsePayload (payload, m2mToken, isCreated = true) {
  try {
    let projectId
    if (_.get(payload, 'legacy.directProjectId')) {
      projectId = payload.legacy.directProjectId
    } else {
      projectId = _.get((await getDirectProjectId(m2mToken, payload.projectId)), 'directProjectId')
      if (!projectId) throw new Error(`Could not find Direct Project ID for Project ${payload.projectId}`)
    }
    const data = {
      track: _.get(payload, 'legacy.track'), // FIXME: thomas
      name: payload.name,
      reviewType: _.get(payload, 'legacy.reviewType'),
      projectId,
      status: payload.status
    }
    if (payload.billingAccountId) {
      data.billingAccountId = payload.billingAccountId
    }
    if (_.get(payload, 'legacy.forumId')) {
      data.forumId = payload.legacy.forumId
    }
    if (payload.copilotId) {
      data.copilotId = payload.copilotId
    }
    if (isCreated) {
      // hard code some required properties for v4 api
      data.confidentialityType = _.get(payload, 'legacy.confidentialityType', 'public')
      data.submissionGuidelines = 'Please read above'
      data.submissionVisibility = true
      data.milestoneId = 1
    }
    if (payload.typeId) {
      const typeRes = await helper.getRequest(`${config.V5_CHALLENGE_TYPE_API_URL}/${payload.typeId}`, m2mToken)
      data.subTrack = typeRes.body.abbreviation // FIXME: thomas
      // TASK is named as FIRST_2_FINISH on legacy
      if (data.subTrack === constants.challengeAbbreviations.TASK) {
        data.task = true
        data.subTrack = constants.challengeAbbreviations.FIRST_2_FINISH
      }
      data.legacyTypeId = typeRes.body.legacyId
    }
    if (payload.description) {
      try {
        data.detailedRequirements = converter.makeHtml(payload.description)
      } catch (e) {
        data.detailedRequirements = payload.description
      }
    }
    if (payload.privateDescription) {
      try {
        data.privateDescription = converter.makeHtml(payload.privateDescription)
      } catch (e) {
        data.privateDescription = payload.privateDescription
      }
    }
    if (payload.phases) {
      const registrationPhase = _.find(payload.phases, p => p.phaseId === config.REGISTRATION_PHASE_ID)
      const submissionPhase = _.find(payload.phases, p => p.phaseId === config.SUBMISSION_PHASE_ID)
      data.registrationStartsAt = new Date().toISOString()
      data.registrationEndsAt = new Date(Date.now() + (registrationPhase || submissionPhase).duration).toISOString()
      data.registrationDuration = (registrationPhase || submissionPhase).duration
      data.submissionEndsAt = new Date(Date.now() + submissionPhase.duration).toISOString()
      data.submissionDuration = submissionPhase.duration

      // Only Design can have checkpoint phase and checkpoint prizes
      const checkpointPhase = _.find(payload.phases, p => p.phaseId === config.CHECKPOINT_SUBMISSION_PHASE_ID)
      if (checkpointPhase) {
        data.checkpointSubmissionStartsAt = new Date().toISOString()
        data.checkpointSubmissionEndsAt = new Date(Date.now() + checkpointPhase.duration).toISOString()
        data.checkpointSubmissionDuration = checkpointPhase.duration
      } else {
        data.checkpointSubmissionStartsAt = null
        data.checkpointSubmissionEndsAt = null
        data.checkpointSubmissionDuration = null
      }
    }
    if (payload.prizeSets) {
      // Only Design can have checkpoint phase and checkpoint prizes
      const checkpointPrize = _.find(payload.prizeSets, { type: constants.prizeSetTypes.CheckPoint })
      if (checkpointPrize) {
        // checkpoint prize are the same for each checkpoint submission winner
        data.numberOfCheckpointPrizes = checkpointPrize.prizes.length
        data.checkpointPrize = checkpointPrize.prizes[0].value
      } else {
        data.numberOfCheckpointPrizes = 0
        data.checkpointPrize = 0
      }

      // prize type can be Challenge prizes
      const challengePrizes = _.find(payload.prizeSets, { type: constants.prizeSetTypes.ChallengePrizes })
      if (!challengePrizes) {
        throw new Error('Challenge prize information is invalid.')
      }
      data.prizes = _.map(challengePrizes.prizes, 'value').sort((a, b) => b - a)
    }
    if (payload.tags) {
      const techResult = await getTechnologies(m2mToken)
      data.technologies = _.filter(techResult.result.content, e => payload.tags.includes(e.name))

      const platResult = await getPlatforms(m2mToken)
      data.platforms = _.filter(platResult.result.content, e => payload.tags.includes(e.name))
    }
    return data
  } catch (err) {
    // Debugging
    logger.debug(err)
    if (err.status) {
      // extract error message from V5 API
      const message = _.get(err, 'response.body.message')
      throw new Error(message)
    } else {
      throw err
    }
  }
}

/**
 * Activate challenge
 * @param {Number} challengeId the challenge ID
 */
async function activateChallenge (challengeId) {
  const m2mToken = await helper.getM2MToken()
  return helper.postRequest(`${config.V4_CHALLENGE_API_URL}/${challengeId}/activate`, null, m2mToken)
}

/**
 * Close challenge
 * @param {Number} challengeId the challenge ID
 * @param {Number} winnerId the winner ID
 */
async function closeChallenge (challengeId, winnerId) {
  const m2mToken = await helper.getM2MToken()
  return helper.postRequest(`${config.V4_CHALLENGE_API_URL}/${challengeId}/close?winnerId=${winnerId}`, null, m2mToken)
}

/**
 * Process create challenge message
 * @param {Object} message the kafka message
 */
async function processCreate (message) {
  if (message.payload.status === constants.challengeStatuses.New) {
    logger.debug(`Will skip creating on legacy as status is ${constants.challengeStatuses.New}`)
    return
  }
  const m2mToken = await helper.getM2MToken()

  const saveDraftContestDTO = await parsePayload(message.payload, m2mToken)
  logger.debug('Parsed Payload', saveDraftContestDTO)
  const challengeUuid = message.payload.id

  logger.debug('processCreate :: beforeTry')
  try {
    const newChallenge = await helper.postRequest(`${config.V4_CHALLENGE_API_URL}`, { param: saveDraftContestDTO }, m2mToken)
    await helper.patchRequest(`${config.V5_CHALLENGE_API_URL}/${challengeUuid}`, {
      legacy: {
        ...message.payload.legacy,
        directProjectId: newChallenge.body.result.content.projectId,
        forumId: _.get(newChallenge, 'body.result.content.forumId', message.payload.legacy.forumId),
        informixModified: _.get(newChallenge, 'body.result.content.updatedAt', new Date())
      },
      legacyId: newChallenge.body.result.content.id
    }, m2mToken)
    logger.debug('End of processCreate')
  } catch (e) {
    logger.error('processCreate Catch', e)
    throw e
  }
}

processCreate.schema = {
  message: Joi.object().keys({
    topic: Joi.string().required(),
    originator: Joi.string().required(),
    timestamp: Joi.date().required(),
    'mime-type': Joi.string().required(),
    payload: Joi.object().keys({
      id: Joi.string().required(),
      typeId: Joi.string(),
      legacy: Joi.object().keys({
        track: Joi.string().required(),
        reviewType: Joi.string().required(),
        confidentialityType: Joi.string(),
        directProjectId: Joi.number(),
        forumId: Joi.number().integer().positive()
      }),
      billingAccountId: Joi.number(),
      name: Joi.string().required(),
      description: Joi.string(),
      privateDescription: Joi.string(),
      phases: Joi.array().items(Joi.object().keys({
        id: Joi.string().required(),
        duration: Joi.number().positive().required()
      }).unknown(true)),
      prizeSets: Joi.array().items(Joi.object().keys({
        type: Joi.string().valid(_.values(constants.prizeSetTypes)).required(),
        prizes: Joi.array().items(Joi.object().keys({
          value: Joi.number().positive().required()
        }).unknown(true)).min(1).required()
      }).unknown(true)),
      tags: Joi.array().items(Joi.string().required()), // tag names
      projectId: Joi.number().integer().positive().required(),
      copilotId: Joi.number().integer().positive().optional(),
      status: Joi.string().valid(_.values(Object.keys(constants.createChallengeStatusesMap))).required()
    }).unknown(true).required()
  }).required()
}

/**
 * Process update challenge message
 * @param {Object} message the kafka message
 */
async function processUpdate (message) {
  if (message.payload.status === constants.challengeStatuses.New) {
    logger.debug(`Will skip creating on legacy as status is ${constants.challengeStatuses.New}`)
    return
  } else if (!message.payload.legacyId) {
    logger.debug('Legacy ID does not exist. Will create...')
    return processCreate(message)
  }
  const m2mToken = await helper.getM2MToken()

  const saveDraftContestDTO = await parsePayload(message.payload, m2mToken, false)
  logger.debug('Parsed Payload', saveDraftContestDTO)
  let challenge
  try {
    // ensure challenge existed
    challenge = await getChallengeById(m2mToken, message.payload.legacyId)
  } catch (e) {
    // postponne kafka event
    logger.info('Challenge does not exist yet. Will post the same message back to the bus API')
    await helper.postBusEvent(config.UPDATE_CHALLENGE_TOPIC, message.payload)
    return
  }
  try {
    if (!challenge) {
      throw new Error(`Could not find challenge ${message.payload.legacyId}`)
    }
    await helper.putRequest(`${config.V4_CHALLENGE_API_URL}/${message.payload.legacyId}`, { param: saveDraftContestDTO }, m2mToken)

    if (message.payload.status) {
      logger.info(`The status has changed from ${challenge.currentStatus} to ${message.payload.status}`)
      if (message.payload.status === constants.challengeStatuses.Active && challenge.currentStatus !== constants.challengeStatuses.Active) {
        logger.info('Activating challenge...')
        await activateChallenge(message.payload.legacyId)
        logger.info('Activated!')
      }
      if (message.payload.status === constants.challengeStatuses.Completed && challenge.currentStatus !== constants.challengeStatuses.Completed) {
        const challengeUuid = message.payload.id
        const v5Challenge = await helper.getRequest(`${config.V5_CHALLENGE_API_URL}/${challengeUuid}`, m2mToken)
        if (v5Challenge.body.typeId === config.TASK_TYPE_ID) {
          logger.info('Challenge type is TASK')
          if (!message.payload.winners || message.payload.winners.length === 0) {
            throw new Error('Cannot close challenge without winners')
          }
          const winnerId = _.find(message.payload.winners, winner => winner.placement === 1).userId
          logger.info(`Will close the challenge with ID ${message.payload.legacyId}. Winner ${winnerId}!`)
          await closeChallenge(message.payload.legacyId, winnerId)
        } else {
          logger.info(`Challenge type is ${v5Challenge.body.typeId}.. Skip closing challenge...`)
        }
      }
    }
    // we can't switch the challenge type
    // TODO: track is missing from the response.
    // if (message.payload.legacy.track) {
    //   const newTrack = message.payload.legacy.track
    //   // track information is stored in subTrack of V4 API
    //   if (challenge.track !== newTrack) {
    //     // refer ContestDirectManager.prepare in ap-challenge-microservice
    //     throw new Error('You can\'t change challenge track')
    //   }
    // }
  } catch (e) {
    logger.error('processUpdate Catch', e)
    throw e
  }
}

processUpdate.schema = {
  message: Joi.object().keys({
    topic: Joi.string().required(),
    originator: Joi.string().required(),
    timestamp: Joi.date().required(),
    'mime-type': Joi.string().required(),
    payload: Joi.object().keys({
      legacyId: Joi.number().integer().positive(),
      legacy: Joi.object().keys({
        track: Joi.string().required(),
        reviewType: Joi.string().required(),
        confidentialityType: Joi.string(),
        directProjectId: Joi.number(),
        forumId: Joi.number().integer().positive(),
        informixModified: Joi.string()
      }),
      billingAccountId: Joi.number(),
      typeId: Joi.string(),
      name: Joi.string(),
      description: Joi.string(),
      privateDescription: Joi.string(),
      phases: Joi.array().items(Joi.object().keys({
        id: Joi.string().required(),
        duration: Joi.number().positive().required()
      }).unknown(true)),
      prizeSets: Joi.array().items(Joi.object().keys({
        type: Joi.string().valid(_.values(constants.prizeSetTypes)).required(),
        prizes: Joi.array().items(Joi.object().keys({
          value: Joi.number().positive().required()
        }).unknown(true))
      }).unknown(true)).min(1),
      tags: Joi.array().items(Joi.string().required()).min(1), // tag names
      projectId: Joi.number().integer().positive().allow(null)
    }).unknown(true).required()
  }).required()
}

module.exports = {
  processCreate,
  processUpdate
}

logger.buildService(module.exports)
