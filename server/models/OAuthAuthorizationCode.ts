import { CreationOptional, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import models from '.';

class OAuthAuthorizationCode extends Model<
  InferAttributes<OAuthAuthorizationCode>,
  InferCreationAttributes<OAuthAuthorizationCode>
> {
  public declare readonly id: CreationOptional<number>;
  public declare code: string;
  public declare redirectUri: string;
  public declare expiresAt: Date;
  public declare data: Record<string, unknown>;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare ApplicationId: number;
  public declare UserId: number;

  public declare application?: NonAttribute<typeof models.Application>;
  public declare user?: NonAttribute<typeof models.User>;
}

OAuthAuthorizationCode.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    redirectUri: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    ApplicationId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Applications' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      allowNull: false,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    // Standard temporal fields
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'OAuthAuthorizationCodes',
    paranoid: true, // For soft-deletion
  },
);

export default OAuthAuthorizationCode;
