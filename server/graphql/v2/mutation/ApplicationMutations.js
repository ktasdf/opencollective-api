import config from 'config';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import models from '../../../models';
import { Forbidden, NotFound, RateLimitExceeded, Unauthorized } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput.js';
import { ApplicationCreateInput } from '../input/ApplicationCreateInput';
import { ApplicationReferenceInput, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { ApplicationUpdateInput } from '../input/ApplicationUpdateInput';
import { Application } from '../object/Application';

const createApplication = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationCreateInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to create an application.');
    }

    const collective = args.application.account
      ? await fetchAccountWithReference(args.application.account, { throwIfMissing: true })
      : req.remoteUser.collective;

    if (!req.remoteUser.isAdminOfCollective(collective)) {
      throw new Forbidden();
    }

    const numberOfAppsForThisAccount = await models.Application.count({ where: { CollectiveId: collective.id } });
    if (numberOfAppsForThisAccount >= config.limits.maxNumberOfAppsPerUser) {
      throw new RateLimitExceeded('You have reached the maximum number of applications for this user');
    }

    const createParams = {
      ...pick(args.application, ['type', 'name', 'description']),
      callbackUrl: args.application.redirectUri,
      CreatedByUserId: req.remoteUser.id,
      CollectiveId: collective.id,
    };

    return models.Application.create(createParams);
  },
};

const updateApplication = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationUpdateInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to update an application.');
    }

    const application = await fetchApplicationWithReference(args.application, {
      include: [{ association: 'collective', required: true }],
    });
    if (!application) {
      throw new NotFound(`Application not found`);
    } else if (!req.remoteUser.isAdminOfCollective(application.collective)) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    const updateParams = pick(args.application, ['name', 'description']);

    // Doing this we're not supporting update to NULL
    if (args.application.redirectUri) {
      updateParams.callbackUrl = args.application.redirectUri;
    }

    return application.update(updateParams);
  },
};

const deleteApplication = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationReferenceInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to delete an application.');
    }

    const application = await fetchApplicationWithReference(args.application, {
      include: [{ association: 'collective', required: true }],
    });
    if (!application) {
      throw new NotFound(`Application not found`);
    } else if (!req.remoteUser.isAdminOfCollective(application.collective)) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    return application.destroy();
  },
};

const applicationMutations = {
  createApplication,
  updateApplication,
  deleteApplication,
};

export default applicationMutations;
