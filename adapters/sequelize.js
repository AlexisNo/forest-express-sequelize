'use strict';
var _ = require('lodash');
var P = require('bluebird');
var Interface = require('forest-express');

module.exports = function (model, opts) {
  var fields = [];
  var fieldNamesToExclude = [];
  var DataTypes = opts.sequelize;

  function getTypeFor(column) {
    if (column.type instanceof DataTypes.STRING ||
      column.type instanceof DataTypes.TEXT ||
      column.type instanceof DataTypes.UUID || column.type === 'citext') {
      return 'String';
    } else if (column.type instanceof DataTypes.ENUM) {
      return 'Enum';
    } else if (column.type instanceof DataTypes.BOOLEAN) {
      return 'Boolean';
    } else if (column.type instanceof DataTypes.DATEONLY) {
      return 'Dateonly';
    } else if (column.type instanceof DataTypes.DATE) {
      return 'Date';
    } else if (column.type instanceof DataTypes.INTEGER ||
      column.type instanceof DataTypes.FLOAT ||
      column.type instanceof DataTypes['DOUBLE PRECISION'] ||
      column.type instanceof DataTypes.BIGINT ||
      column.type instanceof DataTypes.DECIMAL) {
      return 'Number';
    } else if (column.type instanceof DataTypes.JSONB ||
      column.type instanceof DataTypes.JSON) {
      return 'Json';
    } else if (column.type instanceof DataTypes.TIME) {
      return 'Time';
    } else if (column.type.type) {
      return [getTypeFor({ type: column.type.type })];
    }
  }

  function getTypeForAssociation(association) {
    var attribute = association.target.attributes[association.targetKey];
    var type = attribute ? getTypeFor(attribute) : 'Number';

    switch (association.associationType) {
      case 'BelongsTo':
      case 'HasOne':
        return type;
      case 'HasMany':
      case 'BelongsToMany':
        return [type];
    }
  }

  function getValidations(column) {
    var validations = [];

    // NOTICE: Do not inspect validation for autogenerated fields, it would
    //         block the record creation/update.
    if (column._autoGenerated === true) { return validations; }

    if (column.allowNull === false) {
      validations.push({
        type: 'is present'
      });
    }

    if (!column.validate) { return validations; }

    if (column.validate.min) {
      validations.push({
        type: 'is greater than',
        value: column.validate.min.args || column.validate.min,
        message: column.validate.min.msg
      });
    }

    if (column.validate.max) {
      validations.push({
        type: 'is less than',
        value: column.validate.max.args || column.validate.max,
        message: column.validate.max.msg
      });
    }

    if (column.validate.isBefore) {
      validations.push({
        type: 'is before',
        value: column.validate.isBefore.args || column.validate.isBefore,
        message: column.validate.isBefore.msg
      });
    }

    if (column.validate.isAfter) {
      validations.push({
        type: 'is after',
        value: column.validate.isAfter.args || column.validate.isAfter,
        message: column.validate.isAfter.msg
      });
    }

    if (column.validate.len) {
      var length = column.validate.len.args || column.validate.len;

      if (length[0] && length[1]) {
        validations.push({
          type: 'is longer than',
          value: length[0],
          message: column.validate.len.msg
        });

        validations.push({
          type: 'is shorter than',
          value: length[1],
          message: column.validate.len.msg
        });
      } else {
        validations.push({
          type: 'is longer than',
          value: length,
          message: column.validate.len.msg
        });
      }
    }

    if (column.validate.contains) {
      validations.push({
        type: 'contains',
        value: column.validate.contains.args || column.validate.contains,
        message: column.validate.contains.msg
      });
    }

    if (column.validate.is && !_.isArray(column.validate.is)) {
      var value = column.validate.is.args || column.validate.is;

      validations.push({
        type: 'is like',
        value: value.toString(),
        message: column.validate.is.msg
      });
    }

    return validations;
  }

  function getIsRequired(column) {
    return column._autoGenerated !== true && column.allowNull === false;
  }

  function getSchemaForColumn(column) {
    var schema = {
      field: column.fieldName,
      type: getTypeFor(column),
      // NOTICE: Necessary only for fields with different field and database
      //         column names
      columnName: column.field
    };

    if (column.primaryKey === true) {
      schema.primaryKey = true;
    }
    if (schema.type === 'Enum') {
      schema.enums = column.values;
    }

    if (getIsRequired(column)) {
      schema.isRequired = true;
    }

    if (!_.isNull(column.defaultValue) && !_.isUndefined(column.defaultValue)) {
      // NOTICE: Do not use the primary keys default values to prevent issues
      //         with UUID fields (defaultValue: DataTypes.UUIDV4).
      if (!_.includes(_.keys(model.primaryKeys), column.fieldName)) {
        schema.defaultValue = column.defaultValue;
      }
    }

    schema.validations = getValidations(column);

    if (schema.validations.length === 0) {
      delete schema.validations;
    }

    return schema;
  }

  function getSchemaForAssociation(association) {
    var schema = {
      field: association.associationAccessor,
      type: getTypeForAssociation(association),
      // TODO: For BelongsTo associations, the reference does not seem to be
      //       correct; the target name is correct, but not the second part.
      reference: association.target.name + '.' + association.foreignKey,
      inverseOf: null
    };

    // NOTICE: Detect potential foreign keys that should be excluded, if a
    //         constraints property is set for example.
    if (association.associationType === 'BelongsTo') {
      fieldNamesToExclude.push(association.identifierField);
    }

    return schema;
  }

  var columns = P
    .each(_.values(model.attributes), function (column) {
      try {
        if (column.references && !column.primaryKey) { return; }

        var schema = getSchemaForColumn(column);
        fields.push(schema);
      } catch (error) {
        Interface.logger.error('Cannot fetch properly column ' + column.field +
          ' of model ' + model.name, error);
      }
    });

  var associations = P
    .each(_.values(model.associations), function (association) {
      try {
        var schema = getSchemaForAssociation(association);
        fields.push(schema);
      } catch (error) {
        Interface.logger.error('Cannot fetch properly association ' +
          association.associationAccessor + ' of model ' + model.name, error);
      }
    });

  return P.all([columns, associations])
    .then(function () {
      var isCompositePrimary = false;
      var primaryKeys = _.keys(model.primaryKeys);
      var idField = primaryKeys[0];

      if (_.keys(model.primaryKeys).length > 1) {
        isCompositePrimary = true;
        idField = 'forestCompositePrimary';
      }

      _.remove(fields, function (field) {
        return _.includes(fieldNamesToExclude, field.columnName) &&
          !field.primaryKey;
      });

      return {
        name: model.name,
        idField: idField,
        primaryKeys: primaryKeys,
        isCompositePrimary: isCompositePrimary,
        fields: fields
      };
    });
};
