const _ = require(`lodash`)
const invariant = require(`invariant`)
const {
  isSpecifiedScalarType,
  isIntrospectionType,
  assertValidName,
  parse,
  GraphQLNonNull,
  GraphQLList,
} = require(`graphql`)
const {
  ObjectTypeComposer,
  InterfaceTypeComposer,
  UnionTypeComposer,
  InputTypeComposer,
  ScalarTypeComposer,
  EnumTypeComposer,
} = require(`graphql-compose`)

const apiRunner = require(`../utils/api-runner-node`)
const report = require(`gatsby-cli/lib/reporter`)
const { addNodeInterfaceFields } = require(`./types/node-interface`)
const { addInferredType, addInferredTypes } = require(`./infer`)
const { findOne, findManyPaginated } = require(`./resolvers`)
const {
  processFieldExtensions,
  internalExtensionNames,
} = require(`./extensions`)
const { getPagination } = require(`./types/pagination`)
const { getSortInput } = require(`./types/sort`)
const { getFilterInput } = require(`./types/filter`)
const { isGatsbyType, GatsbyGraphQLTypeKind } = require(`./types/type-builders`)
const { printTypeDefinitions } = require(`./print`)

const buildSchema = async ({
  schemaComposer,
  nodeStore,
  types,
  typeMapping,
  fieldExtensions,
  thirdPartySchemas,
  printConfig,
  typeConflictReporter,
  parentSpan,
}) => {
  await updateSchemaComposer({
    schemaComposer,
    nodeStore,
    types,
    typeMapping,
    fieldExtensions,
    thirdPartySchemas,
    printConfig,
    typeConflictReporter,
    parentSpan,
  })
  // const { printSchema } = require(`graphql`)
  const schema = schemaComposer.buildSchema()
  // console.log(printSchema(schema))
  return schema
}

const rebuildSchemaWithSitePage = async ({
  schemaComposer,
  nodeStore,
  typeMapping,
  fieldExtensions,
  typeConflictReporter,
  parentSpan,
}) => {
  const typeComposer = schemaComposer.getOTC(`SitePage`)
  const shouldInfer =
    !typeComposer.hasExtension(`infer`) ||
    typeComposer.getExtension(`infer`) !== false
  if (shouldInfer) {
    addInferredType({
      schemaComposer,
      typeComposer,
      nodeStore,
      typeConflictReporter,
      typeMapping,
      parentSpan,
    })
  }
  await processTypeComposer({
    schemaComposer,
    typeComposer,
    fieldExtensions,
    nodeStore,
    parentSpan,
  })
  return schemaComposer.buildSchema()
}

module.exports = {
  buildSchema,
  rebuildSchemaWithSitePage,
}

const updateSchemaComposer = async ({
  schemaComposer,
  nodeStore,
  types,
  typeMapping,
  fieldExtensions,
  thirdPartySchemas,
  printConfig,
  typeConflictReporter,
  parentSpan,
}) => {
  await addTypes({ schemaComposer, parentSpan, types })
  await addInferredTypes({
    schemaComposer,
    nodeStore,
    typeConflictReporter,
    typeMapping,
    parentSpan,
  })
  await printTypeDefinitions({ config: printConfig, schemaComposer })
  await addSetFieldsOnGraphQLNodeTypeFields({
    schemaComposer,
    nodeStore,
    parentSpan,
  })
  await Promise.all(
    Array.from(new Set(schemaComposer.values())).map(typeComposer =>
      processTypeComposer({
        schemaComposer,
        typeComposer,
        fieldExtensions,
        nodeStore,
        parentSpan,
      })
    )
  )
  checkQueryableInterfaces({ schemaComposer })
  await addConvenienceChildrenFields({ schemaComposer, parentSpan })
  await addThirdPartySchemas({ schemaComposer, thirdPartySchemas, parentSpan })
  await addCustomResolveFunctions({ schemaComposer, parentSpan })
}

const processTypeComposer = async ({
  schemaComposer,
  typeComposer,
  fieldExtensions,
  nodeStore,
  parentSpan,
}) => {
  if (typeComposer instanceof ObjectTypeComposer) {
    await processFieldExtensions({
      schemaComposer,
      typeComposer,
      fieldExtensions,
      parentSpan,
    })
    if (typeComposer.hasInterface(`Node`)) {
      await addNodeInterfaceFields({ schemaComposer, typeComposer, parentSpan })
      await addImplicitConvenienceChildrenFields({
        schemaComposer,
        typeComposer,
        nodeStore,
        parentSpan,
      })
      await addTypeToRootQuery({ schemaComposer, typeComposer, parentSpan })
    }
  } else if (typeComposer instanceof InterfaceTypeComposer) {
    if (typeComposer.getExtension(`nodeInterface`)) {
      // We only process field extensions for queryable Node interfaces, so we get
      // the input args on the root query type, e.g. `formatString` etc. for `dateformat`
      await processFieldExtensions({
        schemaComposer,
        typeComposer,
        fieldExtensions,
        parentSpan,
      })
      await addTypeToRootQuery({ schemaComposer, typeComposer, parentSpan })
    }
  }
}

const addTypes = ({ schemaComposer, types, parentSpan }) => {
  types.forEach(({ typeOrTypeDef, plugin }) => {
    if (typeof typeOrTypeDef === `string`) {
      let parsedTypes
      const createdFrom = `sdl`
      try {
        parsedTypes = parseTypeDefs({
          typeDefs: typeOrTypeDef,
          plugin,
          createdFrom,
          schemaComposer,
          parentSpan,
        })
      } catch (error) {
        reportParsingError(error)
        return
      }
      parsedTypes.forEach(type => {
        processAddedType({
          schemaComposer,
          type,
          parentSpan,
          createdFrom,
          plugin,
        })
      })
    } else if (isGatsbyType(typeOrTypeDef)) {
      const type = createTypeComposerFromGatsbyType({
        schemaComposer,
        type: typeOrTypeDef,
        parentSpan,
      })

      if (type) {
        const typeName = type.getTypeName()
        const createdFrom = `typeBuilder`
        checkIsAllowedTypeName(typeName)
        if (schemaComposer.has(typeName)) {
          const typeComposer = schemaComposer.get(typeName)
          mergeTypes({
            schemaComposer,
            typeComposer,
            type,
            plugin,
            createdFrom,
            parentSpan,
          })
        } else {
          processAddedType({
            schemaComposer,
            type,
            parentSpan,
            createdFrom,
            plugin,
          })
        }
      }
    } else {
      const typeName = typeOrTypeDef.name
      const createdFrom = `graphql-js`
      checkIsAllowedTypeName(typeName)
      if (schemaComposer.has(typeName)) {
        const typeComposer = schemaComposer.get(typeName)
        mergeTypes({
          schemaComposer,
          typeComposer,
          type: typeOrTypeDef,
          plugin,
          createdFrom,
          parentSpan,
        })
      } else {
        processAddedType({
          schemaComposer,
          type: typeOrTypeDef,
          parentSpan,
          createdFrom,
          plugin,
        })
      }
    }
  })
}

const mergeTypes = ({
  schemaComposer,
  typeComposer,
  type,
  plugin,
  createdFrom,
  parentSpan,
}) => {
  // Only allow user or plugin owning the type to extend already existing type.
  const typeOwner = typeComposer.getExtension(`plugin`)
  if (
    !plugin ||
    plugin.name === `default-site-plugin` ||
    plugin.name === typeOwner
  ) {
    typeComposer.merge(type)
    if (isNamedTypeComposer(type)) {
      typeComposer.extendExtensions(type.getExtensions())
    }
    addExtensions({ schemaComposer, typeComposer, plugin, createdFrom })
    return true
  } else {
    report.warn(
      `Plugin \`${plugin.name}\` tried to define the GraphQL type ` +
        `\`${typeComposer.getTypeName()}\`, which has already been defined ` +
        `by the plugin \`${typeOwner}\`.`
    )
    return false
  }
}

const processAddedType = ({
  schemaComposer,
  type,
  parentSpan,
  createdFrom,
  plugin,
}) => {
  const typeName = schemaComposer.addAsComposer(type)
  const typeComposer = schemaComposer.get(typeName)
  if (
    typeComposer instanceof InterfaceTypeComposer ||
    typeComposer instanceof UnionTypeComposer
  ) {
    if (!typeComposer.getResolveType()) {
      typeComposer.setResolveType(node => node.internal.type)
    }
  }
  schemaComposer.addSchemaMustHaveType(typeComposer)

  addExtensions({ schemaComposer, typeComposer, plugin, createdFrom })

  return typeComposer
}

const addExtensions = ({
  schemaComposer,
  typeComposer,
  plugin,
  createdFrom,
}) => {
  typeComposer.setExtension(`createdFrom`, createdFrom)
  typeComposer.setExtension(`plugin`, plugin ? plugin.name : null)

  if (createdFrom === `sdl`) {
    const directives = typeComposer.getDirectives()
    directives.forEach(({ name, args }) => {
      switch (name) {
        case `infer`:
        case `dontInfer`:
          typeComposer.setExtension(`infer`, name === `infer`)
          if (args.noDefaultResolvers != null) {
            typeComposer.setExtension(
              `addDefaultResolvers`,
              !args.noDefaultResolvers
            )
          }
          break
        case `mimeTypes`:
          typeComposer.setExtension(`mimeTypes`, args)
          break
        case `childOf`:
          typeComposer.setExtension(`childOf`, args)
          break
        case `nodeInterface`:
          if (typeComposer instanceof InterfaceTypeComposer) {
            if (
              !typeComposer.hasField(`id`) ||
              typeComposer.getFieldType(`id`).toString() !== `ID!`
            ) {
              report.panic(
                `Interfaces with the \`nodeInterface\` extension must have a field ` +
                  `\`id\` of type \`ID!\`. Check the type definition of ` +
                  `\`${typeComposer.getTypeName()}\`.`
              )
            }
            typeComposer.setExtension(`nodeInterface`, true)
          }
          break
        default:
      }
    })
  }

  if (
    typeComposer instanceof ObjectTypeComposer ||
    typeComposer instanceof InterfaceTypeComposer ||
    typeComposer instanceof InputTypeComposer
  ) {
    typeComposer.getFieldNames().forEach(fieldName => {
      typeComposer.setFieldExtension(fieldName, `createdFrom`, createdFrom)
      typeComposer.setFieldExtension(
        fieldName,
        `plugin`,
        plugin ? plugin.name : null
      )

      if (createdFrom === `sdl`) {
        const directives = typeComposer.getFieldDirectives(fieldName)
        directives.forEach(({ name, args }) => {
          typeComposer.setFieldExtension(fieldName, name, args)
        })
      }

      // Validate field extension args. `graphql-compose` already checks the
      // type of directive args in `parseDirectives`, but we want to check
      // extensions provided with type builders as well. Also, we warn if an
      // extension option was provided which does not exist in the field
      // extension definition.
      const fieldExtensions = typeComposer.getFieldExtensions(fieldName)
      const typeName = typeComposer.getTypeName()
      Object.keys(fieldExtensions)
        .filter(name => !internalExtensionNames.includes(name))
        .forEach(name => {
          const args = fieldExtensions[name]

          if (!args || typeof args !== `object`) {
            report.error(
              `Field extension arguments must be provided as an object. ` +
                `Received "${args}" on \`${typeName}.${fieldName}\`.`
            )
            return
          }

          try {
            const definition = schemaComposer.getDirective(name)

            // Handle `defaultValue` when not provided as directive
            definition.args.forEach(({ name, defaultValue }) => {
              if (args[name] === undefined && defaultValue !== undefined) {
                args[name] = defaultValue
              }
            })

            Object.keys(args).forEach(arg => {
              const argumentDef = definition.args.find(
                ({ name }) => name === arg
              )
              if (!argumentDef) {
                report.error(
                  `Field extension \`${name}\` on \`${typeName}.${fieldName}\` ` +
                    `has invalid argument \`${arg}\`.`
                )
                return
              }
              const value = args[arg]
              try {
                validate(argumentDef.type, value)
              } catch (error) {
                report.error(
                  `Field extension \`${name}\` on \`${typeName}.${fieldName}\` ` +
                    `has argument \`${arg}\` with invalid value "${value}". ` +
                    error.message
                )
              }
            })
          } catch (error) {
            report.error(
              `Field extension \`${name}\` on \`${typeName}.${fieldName}\` ` +
                `is not available.`
            )
          }
        })
    })
  }

  if (typeComposer.hasExtension(`addDefaultResolvers`)) {
    report.warn(
      `Deprecation warning - "noDefaultResolvers" is deprecated. In Gatsby 3, ` +
        `defined fields won't get resolvers, unless explicitly added with a ` +
        `directive/extension.`
    )
  }

  return typeComposer
}

const checkIsAllowedTypeName = name => {
  invariant(
    name !== `Node`,
    `The GraphQL type \`Node\` is reserved for internal use.`
  )
  invariant(
    !name.endsWith(`FilterInput`) && !name.endsWith(`SortInput`),
    `GraphQL type names ending with "FilterInput" or "SortInput" are ` +
      `reserved for internal use. Please rename \`${name}\`.`
  )
  invariant(
    ![`Boolean`, `Date`, `Float`, `ID`, `Int`, `JSON`, `String`].includes(name),
    `The GraphQL type \`${name}\` is reserved for internal use by ` +
      `built-in scalar types.`
  )
  assertValidName(name)
}

const createTypeComposerFromGatsbyType = ({
  schemaComposer,
  type,
  parentSpan,
}) => {
  switch (type.kind) {
    case GatsbyGraphQLTypeKind.OBJECT: {
      return ObjectTypeComposer.createTemp(
        {
          ...type.config,
          interfaces: () => {
            if (type.config.interfaces) {
              return type.config.interfaces.map(iface => {
                if (typeof iface === `string`) {
                  return schemaComposer.getIFTC(iface).getType()
                } else {
                  return iface
                }
              })
            } else {
              return []
            }
          },
        },
        schemaComposer
      )
    }
    case GatsbyGraphQLTypeKind.INPUT_OBJECT: {
      return InputTypeComposer.createTemp(type.config, schemaComposer)
    }
    case GatsbyGraphQLTypeKind.UNION: {
      return UnionTypeComposer.createTemp(
        {
          ...type.config,
          types: () => {
            if (type.config.types) {
              return type.config.types.map(typeName =>
                schemaComposer.getOTC(typeName).getType()
              )
            } else {
              return []
            }
          },
        },
        schemaComposer
      )
    }
    case GatsbyGraphQLTypeKind.INTERFACE: {
      return InterfaceTypeComposer.createTemp(type.config, schemaComposer)
    }
    case GatsbyGraphQLTypeKind.ENUM: {
      return EnumTypeComposer.createTemp(type.config, schemaComposer)
    }
    case GatsbyGraphQLTypeKind.SCALAR: {
      return ScalarTypeComposer.createTemp(type.config, schemaComposer)
    }
    default: {
      report.warn(`Illegal type definition: ${JSON.stringify(type.config)}`)
      return null
    }
  }
}

const addSetFieldsOnGraphQLNodeTypeFields = ({
  schemaComposer,
  nodeStore,
  parentSpan,
}) =>
  Promise.all(
    Array.from(schemaComposer.values()).map(async tc => {
      if (tc instanceof ObjectTypeComposer && tc.hasInterface(`Node`)) {
        const typeName = tc.getTypeName()
        const result = await apiRunner(`setFieldsOnGraphQLNodeType`, {
          type: {
            name: typeName,
            nodes: nodeStore.getNodesByType(typeName),
          },
          traceId: `initial-setFieldsOnGraphQLNodeType`,
          parentSpan,
        })
        if (result) {
          // NOTE: `setFieldsOnGraphQLNodeType` only allows setting
          // nested fields with a path as property name, i.e.
          // `{ 'frontmatter.published': 'Boolean' }`, but not in the form
          // `{ frontmatter: { published: 'Boolean' }}`
          result.forEach(fields => tc.addNestedFields(fields))
        }
      }
    })
  )

const addThirdPartySchemas = ({
  schemaComposer,
  thirdPartySchemas,
  parentSpan,
}) => {
  thirdPartySchemas.forEach(schema => {
    const schemaQueryType = schema.getQueryType()
    const queryTC = schemaComposer.createTempTC(schemaQueryType)
    processThirdPartyTypeFields({ typeComposer: queryTC, schemaQueryType })
    schemaComposer.Query.addFields(queryTC.getFields())

    // Explicitly add the third-party schema's types, so they can be targeted
    // in `createResolvers` API.
    const types = schema.getTypeMap()
    Object.keys(types).forEach(typeName => {
      const type = types[typeName]
      if (
        type !== schemaQueryType &&
        !isSpecifiedScalarType(type) &&
        !isIntrospectionType(type) &&
        type.name !== `Date` &&
        type.name !== `JSON`
      ) {
        const typeComposer = schemaComposer.createTC(type)
        if (
          typeComposer instanceof ObjectTypeComposer ||
          typeComposer instanceof InterfaceTypeComposer
        ) {
          processThirdPartyTypeFields({ typeComposer, schemaQueryType })
        }
        typeComposer.setExtension(`createdFrom`, `thirdPartySchema`)
        schemaComposer.addSchemaMustHaveType(typeComposer)
      }
    })
  })
}

const processThirdPartyTypeFields = ({ typeComposer, schemaQueryType }) => {
  // Fix for types that refer to Query. Thanks Relay Classic!
  typeComposer.getFieldNames().forEach(fieldName => {
    const field = typeComposer.getField(fieldName)
    const fieldType = field.type.toString()
    if (fieldType.replace(/[[\]!]/g, ``) === schemaQueryType.name) {
      typeComposer.extendField(fieldName, {
        type: fieldType.replace(schemaQueryType.name, `Query`),
      })
    }
  })
}

const addCustomResolveFunctions = async ({ schemaComposer, parentSpan }) => {
  const intermediateSchema = schemaComposer.buildSchema()
  const createResolvers = resolvers => {
    Object.keys(resolvers).forEach(typeName => {
      const fields = resolvers[typeName]
      if (schemaComposer.has(typeName)) {
        const tc = schemaComposer.getOTC(typeName)
        Object.keys(fields).forEach(fieldName => {
          const fieldConfig = fields[fieldName]
          if (tc.hasField(fieldName)) {
            const originalFieldConfig = tc.getFieldConfig(fieldName)
            const originalTypeName = originalFieldConfig.type.toString()
            const originalResolver = originalFieldConfig.resolve
            let fieldTypeName
            if (fieldConfig.type) {
              fieldTypeName = Array.isArray(fieldConfig.type)
                ? stringifyArray(fieldConfig.type)
                : fieldConfig.type.toString()
            }

            if (
              !fieldTypeName ||
              fieldTypeName.replace(/!/g, ``) ===
                originalTypeName.replace(/!/g, ``) ||
              tc.getExtension(`createdFrom`) === `thirdPartySchema`
            ) {
              const newConfig = {}
              if (fieldConfig.type) {
                newConfig.type = fieldConfig.type
              }
              if (fieldConfig.args) {
                newConfig.args = fieldConfig.args
              }
              if (fieldConfig.resolve) {
                newConfig.resolve = (source, args, context, info) =>
                  fieldConfig.resolve(source, args, context, {
                    ...info,
                    originalResolver:
                      originalResolver || context.defaultFieldResolver,
                  })
              }
              tc.extendField(fieldName, newConfig)
            } else if (fieldTypeName) {
              report.warn(
                `\`createResolvers\` passed resolvers for field ` +
                  `\`${typeName}.${fieldName}\` with type \`${fieldTypeName}\`. ` +
                  `Such a field with type \`${originalTypeName}\` already exists ` +
                  `on the type. Use \`createTypes\` to override type fields.`
              )
            }
          } else {
            tc.addFields({ [fieldName]: fieldConfig })
          }
        })
      } else {
        report.warn(
          `\`createResolvers\` passed resolvers for type \`${typeName}\` that ` +
            `doesn't exist in the schema. Use \`createTypes\` to add the type ` +
            `before adding resolvers.`
        )
      }
    })
  }
  await apiRunner(`createResolvers`, {
    intermediateSchema,
    createResolvers,
    traceId: `initial-createResolvers`,
    parentSpan,
  })
}

const addConvenienceChildrenFields = ({ schemaComposer }) => {
  const parentTypesToChildren = new Map()
  const mimeTypesToChildren = new Map()
  const typesHandlingMimeTypes = new Map()

  schemaComposer.forEach(type => {
    if (
      (type instanceof ObjectTypeComposer ||
        type instanceof InterfaceTypeComposer) &&
      type.hasExtension(`mimeTypes`)
    ) {
      const { types } = type.getExtension(`mimeTypes`)
      new Set(types).forEach(mimeType => {
        if (!typesHandlingMimeTypes.has(mimeType)) {
          typesHandlingMimeTypes.set(mimeType, new Set())
        }
        typesHandlingMimeTypes.get(mimeType).add(type)
      })
    }

    if (
      (type instanceof ObjectTypeComposer ||
        type instanceof InterfaceTypeComposer) &&
      type.hasExtension(`childOf`)
    ) {
      if (type instanceof ObjectTypeComposer && !type.hasInterface(`Node`)) {
        report.error(
          `The \`childOf\` extension can only be used on types that implement the \`Node\` interface.\n` +
            `Check the type definition of \`${type.getTypeName()}\`.`
        )
        return
      }
      if (
        type instanceof InterfaceTypeComposer &&
        !type.hasExtension(`nodeInterface`)
      ) {
        report.error(
          `The \`childOf\` extension can only be used on interface types that ` +
            `have the \`@nodeInterface\` extension.\n` +
            `Check the type definition of \`${type.getTypeName()}\`.`
        )
        return
      }

      const { types, mimeTypes, many } = type.getExtension(`childOf`)
      new Set(types).forEach(parentType => {
        if (!parentTypesToChildren.has(parentType)) {
          parentTypesToChildren.set(parentType, new Map())
        }
        parentTypesToChildren.get(parentType).set(type, many)
      })
      new Set(mimeTypes).forEach(mimeType => {
        if (!mimeTypesToChildren.has(mimeType)) {
          mimeTypesToChildren.set(mimeType, new Map())
        }
        mimeTypesToChildren.get(mimeType).set(type, many)
      })
    }
  })

  parentTypesToChildren.forEach((children, parent) => {
    if (!schemaComposer.has(parent)) return
    const typeComposer = schemaComposer.getAnyTC(parent)
    if (
      typeComposer instanceof InterfaceTypeComposer &&
      !typeComposer.hasExtension(`nodeInterface`)
    ) {
      report.error(
        `With the \`childOf\` extension, children fields can only be added to ` +
          `interfaces which have the \`@nodeInterface\` extension.\n` +
          `Check the type definition of \`${typeComposer.getTypeName()}\`.`
      )
      return
    }
    children.forEach((many, child) => {
      if (many) {
        typeComposer.addFields(createChildrenField(child.getTypeName()))
      } else {
        typeComposer.addFields(createChildField(child.getTypeName()))
      }
    })
  })

  mimeTypesToChildren.forEach((children, mimeType) => {
    const parentTypes = typesHandlingMimeTypes.get(mimeType)
    if (parentTypes) {
      parentTypes.forEach(typeComposer => {
        if (
          typeComposer instanceof InterfaceTypeComposer &&
          !typeComposer.hasExtension(`nodeInterface`)
        ) {
          report.error(
            `With the \`childOf\` extension, children fields can only be added to ` +
              `interfaces which have the \`@nodeInterface\` extension.\n` +
              `Check the type definition of \`${typeComposer.getTypeName()}\`.`
          )
          return
        }
        children.forEach((many, child) => {
          if (many) {
            typeComposer.addFields(createChildrenField(child.getTypeName()))
          } else {
            typeComposer.addFields(createChildField(child.getTypeName()))
          }
        })
      })
    }
  })
}

const addImplicitConvenienceChildrenFields = ({
  schemaComposer,
  typeComposer,
  nodeStore,
}) => {
  const shouldInfer = typeComposer.getExtension(`infer`)
  // In Gatsby v3, when `@dontInfer` is set, children fields will not be
  // created for parent-child relations set by plugins with
  // `createParentChildLink`. With `@dontInfer`, only parent-child
  // relations explicitly set with the `childOf` extension will be added.
  // if (shouldInfer === false) return

  const nodes = nodeStore.getNodesByType(typeComposer.getTypeName())

  const childNodesByType = groupChildNodesByType({ nodeStore, nodes })

  Object.keys(childNodesByType).forEach(typeName => {
    const typeChildren = childNodesByType[typeName]
    const maxChildCount = _.maxBy(
      _.values(_.groupBy(typeChildren, c => c.parent)),
      g => g.length
    ).length

    // Adding children fields to types with the `@dontInfer` extension is deprecated
    if (shouldInfer === false) {
      const fieldName = _.camelCase(
        `${maxChildCount > 1 ? `children` : `child`} ${typeName}`
      )
      if (!typeComposer.hasField(fieldName)) {
        report.warn(
          `On types with the \`@dontInfer\` directive, or with the \`infer\` ` +
            `extension set to \`false\`, automatically adding fields for ` +
            `children types is deprecated.\n` +
            `In Gatsby v3, only children fields explicitly set with the ` +
            `\`childOf\` extension will be added.\n` +
            `For example, in Gatsby v3, \`${typeComposer.getTypeName()}\` will ` +
            `not get a \`${fieldName}\` field.`
        )
      }
    }

    if (maxChildCount > 1) {
      typeComposer.addFields(createChildrenField(typeName))
    } else {
      typeComposer.addFields(createChildField(typeName))
    }
  })
}

const createChildrenField = typeName => {
  return {
    [_.camelCase(`children ${typeName}`)]: {
      type: () => [typeName],
      resolve(source, args, context) {
        const { path } = context
        return context.nodeModel.getNodesByIds(
          { ids: source.children, type: typeName },
          { path }
        )
      },
    },
  }
}

const createChildField = typeName => {
  return {
    [_.camelCase(`child ${typeName}`)]: {
      type: () => typeName,
      async resolve(source, args, context) {
        const { path } = context
        const result = await context.nodeModel.getNodesByIds(
          { ids: source.children, type: typeName },
          { path }
        )
        if (result && result.length > 0) {
          return result[0]
        } else {
          return null
        }
      },
    },
  }
}

const groupChildNodesByType = ({ nodeStore, nodes }) =>
  _(nodes)
    .flatMap(node => (node.children || []).map(nodeStore.getNode))
    .groupBy(node => (node.internal ? node.internal.type : undefined))
    .value()

const addTypeToRootQuery = ({ schemaComposer, typeComposer }) => {
  // TODO: We should have an abstraction for keeping and clearing
  // related TypeComposers and InputTypeComposers.
  // Also see the comment on the skipped test in `rebuild-schema`.
  typeComposer.removeInputTypeComposer()

  const sortInputTC = getSortInput({
    schemaComposer,
    typeComposer,
  })
  const filterInputTC = getFilterInput({
    schemaComposer,
    typeComposer,
  })
  const paginationTC = getPagination({
    schemaComposer,
    typeComposer,
  })

  const typeName = typeComposer.getTypeName()
  // not strictly correctly, result is `npmPackage` and `allNpmPackage` from type `NPMPackage`
  const queryName = _.camelCase(typeName)
  const queryNamePlural = _.camelCase(`all ${typeName}`)

  schemaComposer.Query.addFields({
    [queryName]: {
      type: typeComposer,
      args: {
        ...filterInputTC.getFields(),
      },
      resolve: findOne(typeName),
    },
    [queryNamePlural]: {
      type: paginationTC,
      args: {
        filter: filterInputTC,
        sort: sortInputTC,
        skip: `Int`,
        limit: `Int`,
      },
      resolve: findManyPaginated(typeName),
    },
  }).makeFieldNonNull([queryNamePlural])
}

const parseTypes = ({
  doc,
  plugin,
  createdFrom,
  schemaComposer,
  parentSpan,
}) => {
  const types = []
  doc.definitions.forEach(def => {
    const name = def.name.value
    checkIsAllowedTypeName(name)

    if (schemaComposer.has(name)) {
      // We don't check if ast.kind matches composer type, but rely
      // that this will throw when something is wrong and get
      // reported by `reportParsingError`.

      // Keep the original type composer around
      const typeComposer = schemaComposer.get(name)

      // After this, the parsed type composer will be registered as the composer
      // handling the type name
      const parsedType = schemaComposer.typeMapper.makeSchemaDef(def)

      // Merge the parsed type with the original
      mergeTypes({
        schemaComposer,
        typeComposer,
        type: parsedType,
        plugin,
        createdFrom,
        parentSpan,
      })

      // Set the original type composer (with the merged fields added)
      // as the correct composer for the type name
      schemaComposer.typeMapper.set(typeComposer.getTypeName(), typeComposer)
    } else {
      const parsedType = schemaComposer.typeMapper.makeSchemaDef(def)
      types.push(parsedType)
    }
  })
  return types
}

const parseTypeDefs = ({
  typeDefs,
  plugin,
  createdFrom,
  schemaComposer,
  parentSpan,
}) => {
  const doc = parse(typeDefs)
  return parseTypes({ doc, plugin, createdFrom, schemaComposer, parentSpan })
}

const reportParsingError = error => {
  const { message, source, locations } = error

  if (source && locations && locations.length) {
    const { codeFrameColumns } = require(`@babel/code-frame`)

    const frame = codeFrameColumns(
      source.body,
      { start: locations[0] },
      { linesAbove: 5, linesBelow: 5 }
    )
    report.panic(
      `Encountered an error parsing the provided GraphQL type definitions:\n` +
        message +
        `\n\n` +
        frame +
        `\n`
    )
  } else {
    throw error
  }
}

const stringifyArray = arr =>
  `[${arr.map(item =>
    Array.isArray(item) ? stringifyArray(item) : item.toString()
  )}]`

// TODO: Import this directly from graphql-compose once we update to v7
const isNamedTypeComposer = type =>
  type instanceof ObjectTypeComposer ||
  type instanceof InputTypeComposer ||
  type instanceof ScalarTypeComposer ||
  type instanceof EnumTypeComposer ||
  type instanceof InterfaceTypeComposer ||
  type instanceof UnionTypeComposer

const validate = (type, value) => {
  if (type instanceof GraphQLNonNull) {
    if (value == null) {
      throw new Error(`Expected non-null field value.`)
    }
    return validate(type.ofType, value)
  } else if (type instanceof GraphQLList) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array field value.`)
    }
    return value.map(v => validate(type.ofType, v))
  } else {
    return type.parseValue(value)
  }
}

const checkQueryableInterfaces = ({ schemaComposer }) => {
  const queryableInterfaces = new Set()
  schemaComposer.forEach(type => {
    if (
      type instanceof InterfaceTypeComposer &&
      type.getExtension(`nodeInterface`)
    ) {
      queryableInterfaces.add(type.getTypeName())
    }
  })
  const incorrectTypes = []
  schemaComposer.forEach(type => {
    if (type instanceof ObjectTypeComposer) {
      const interfaces = type.getInterfaces()
      if (
        interfaces.some(iface => queryableInterfaces.has(iface.name)) &&
        !type.hasInterface(`Node`)
      ) {
        incorrectTypes.push(type.getTypeName())
      }
    }
  })
  if (incorrectTypes.length) {
    report.panic(
      `Interfaces with the \`nodeInterface\` extension must only be ` +
        `implemented by types which also implement the \`Node\` ` +
        `interface. Check the type definition of ` +
        `${incorrectTypes.map(t => `\`${t}\``).join(`, `)}.`
    )
  }
}
