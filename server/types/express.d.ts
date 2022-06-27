import DataLoader from 'dataloader';

import models from '../models';
import UserToken from '../models/UserToken';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: typeof models.User;
      jwtPayload?: {
        sessionId?: string;
        iat: number;
        exp: number;
        sub?: string;
      };
      clientApp?: {
        id: number;
        type?: string;
        name?: string;
        description?: string;
        CollectiveId: number;
      };
      userToken?: UserToken;
      loaders: Record<string, DataLoader>;
    }
  }
}
