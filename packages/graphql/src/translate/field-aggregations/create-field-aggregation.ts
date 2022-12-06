/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ResolveTree } from "graphql-parse-resolve-info";
import type { Node, Relationship } from "../../classes";
import type { Context, RelationField, GraphQLWhereArg } from "../../types";
import {
    getFieldType,
    AggregationType,
    getReferenceNode,
    getFieldByName,
    getReferenceRelation,
    serializeAuthParamsForApocRun,
} from "./utils";
import * as AggregationSubQueries from "./aggregation-sub-queries";
import { createFieldAggregationAuth } from "./field-aggregations-auth";
import { createMatchWherePattern } from "./aggregation-sub-queries";
import mapToDbProperty from "../../utils/map-to-db-property";
import createWhereAndParams from "../where/create-where-and-params";
import { stringifyObject } from "../utils/stringify-object";
import { serializeParamsForApocRun, wrapInApocRunFirstColumn } from "../utils/apoc-run";
import { FieldAggregationSchemaTypes } from "../../schema/aggregations/field-aggregation-composer";
import { upperFirst } from "../../utils/upper-first";
import { getRelationshipDirectionStr } from "../../utils/get-relationship-direction";
import Cypher from "@neo4j/cypher-builder";

let counter = 0;
let subqueryNodeAlias = "n";
let subqueryRelationAlias = "r";

type AggregationFields = {
    count?: ResolveTree;
    node?: Record<string, ResolveTree>;
    edge?: Record<string, ResolveTree>;
};

export function createFieldAggregation({
    context,
    nodeLabel,
    node,
    field,
}: {
    context: Context;
    nodeLabel: string;
    node: Node;
    field: ResolveTree;
}):
    | { matchVar: string; cypher: string; params: Record<string, any>; preProjectionAggregation: string | undefined }
    | undefined {
    // TODO use cypher builder nodes/vars
    subqueryNodeAlias = `${subqueryNodeAlias}${counter}`;
    subqueryRelationAlias = `${subqueryRelationAlias}${counter}`;
    counter += 1;

    const relationAggregationField = node.relationFields.find((x) => {
        return `${x.fieldName}Aggregate` === field.name;
    });

    const connectionField = node.connectionFields.find((x) => {
        return `${relationAggregationField?.fieldName}Connection` === x.fieldName;
    });

    if (!relationAggregationField || !connectionField) return undefined;
    const referenceNode = getReferenceNode(context, relationAggregationField);
    const referenceRelation = getReferenceRelation(context, connectionField);

    if (!referenceNode || !referenceRelation) return undefined;

    const fieldPathBase = `${node.name}${referenceNode.name}${upperFirst(relationAggregationField.fieldName)}`;
    const aggregationFields = getAggregationFields(fieldPathBase, field);
    const authData = createFieldAggregationAuth({
        node: referenceNode,
        context,
        subqueryNodeAlias,
        nodeFields: aggregationFields.node,
    });

    const [whereQuery, wherePreComputedWhereFields, whereParams] = createWhereAndParams({
        whereInput: (field.args.where as GraphQLWhereArg) || {},
        varName: subqueryNodeAlias,
        node: referenceNode,
        context,
        recursing: true,
        chainStr: `${nodeLabel}_${field.alias}_${subqueryNodeAlias}`,
    });

    const targetPattern = createTargetPattern({
        nodeLabel,
        relationField: relationAggregationField,
        referenceNode,
        context,
        directed: field.args.directed as boolean | undefined,
    });
    const matchWherePattern = createMatchWherePattern(targetPattern, wherePreComputedWhereFields, authData, whereQuery);
    const apocRunParams = {
        ...serializeParamsForApocRun(whereParams as Record<string, any>),
        ...serializeAuthParamsForApocRun(authData),
    };

    const cypherParams = { ...apocRunParams, ...authData.params, ...whereParams };
    const projectionMap = new Cypher.Map();

    let returnMatchPattern = "";
    const countRef = new Cypher.Variable();
    let countFunction: Cypher.Function | undefined;

    if (aggregationFields.count) {
        returnMatchPattern = matchWherePattern;
        countFunction = Cypher.count(new Cypher.NamedNode(subqueryNodeAlias));
        projectionMap.set({
            count: countRef,
        });
    }
    const nodeFields = aggregationFields.node;
    if (nodeFields) {
        projectionMap.set({
            node: new Cypher.RawCypher(() => {
                return [
                    createAggregationQuery({
                        nodeLabel,
                        matchWherePattern,
                        fields: nodeFields,
                        fieldAlias: subqueryNodeAlias,
                        graphElement: referenceNode,
                        params: cypherParams,
                    }),
                    cypherParams,
                ];
            }),
        });
    }
    const edgeFields = aggregationFields.edge;
    if (edgeFields) {
        projectionMap.set({
            edge: new Cypher.RawCypher(() => {
                return [
                    createAggregationQuery({
                        nodeLabel,
                        matchWherePattern,
                        fields: edgeFields,
                        fieldAlias: subqueryRelationAlias,
                        graphElement: referenceRelation,
                        params: cypherParams,
                    }),
                    cypherParams,
                ];
            }),
        });
    }

    let preProjectionAggregation: string | undefined;

    const rawProjection = new Cypher.RawCypher((env) => {
        if (countFunction) {
            preProjectionAggregation = `${countFunction.getCypher(env)} AS ${countRef.getCypher(env)}`;
        }
        return [projectionMap.getCypher(env), cypherParams];
    });

    const result = rawProjection.build(`${nodeLabel}_${field.alias}_`);

    return {
        matchVar: result.cypher,
        cypher: returnMatchPattern,
        params: result.params,
        preProjectionAggregation,
    };
}

function getAggregationFields(fieldPathBase: string, field: ResolveTree): AggregationFields {
    const aggregationFields = field.fieldsByTypeName[`${fieldPathBase}${FieldAggregationSchemaTypes.field}`];
    const node: Record<string, ResolveTree> | undefined = getFieldByName("node", aggregationFields)?.fieldsByTypeName[
        `${fieldPathBase}${FieldAggregationSchemaTypes.node}`
    ];

    const edge: Record<string, ResolveTree> | undefined = getFieldByName("edge", aggregationFields)?.fieldsByTypeName[
        `${fieldPathBase}${FieldAggregationSchemaTypes.edge}`
    ];

    const count = getFieldByName("count", aggregationFields);

    return { count, edge, node };
}

function createTargetPattern({
    nodeLabel,
    relationField,
    referenceNode,
    context,
    directed,
}: {
    nodeLabel: string;
    relationField: RelationField;
    referenceNode: Node;
    context: Context;
    directed?: boolean;
}): string {
    const { inStr, outStr } = getRelationshipDirectionStr(relationField, { directed });
    const nodeOutStr = `(${subqueryNodeAlias}${referenceNode.getLabelString(context)})`;

    return `(${nodeLabel})${inStr}[${subqueryRelationAlias}:${relationField.type}]${outStr}${nodeOutStr}`;
}

function createAggregationQuery({
    nodeLabel,
    matchWherePattern,
    fields,
    fieldAlias,
    graphElement,
    params,
}: {
    nodeLabel: string;
    matchWherePattern: string;
    fields: Record<string, ResolveTree>;
    fieldAlias: string;
    graphElement: Node | Relationship;
    params: Record<string, string>;
}): string {
    const fieldsSubQueries = Object.values(fields).reduce((acc, field) => {
        const fieldType = getFieldType(field);
        const dbProperty = mapToDbProperty(graphElement, field.name);

        const aggregationQuery = wrapInApocRunFirstColumn(
            getAggregationSubquery({
                matchWherePattern,
                fieldName: dbProperty || field.name,
                type: fieldType,
                targetAlias: fieldAlias,
            }),
            {
                ...params,
                [nodeLabel]: nodeLabel,
            }
        );
        acc[field.alias] = `head(${aggregationQuery})`;
        return acc;
    }, {} as Record<string, string>);

    return stringifyObject(fieldsSubQueries);
}

function getAggregationSubquery({
    matchWherePattern,
    fieldName,
    type,
    targetAlias,
}: {
    matchWherePattern: string;
    fieldName: string;
    type: AggregationType | undefined;
    targetAlias: string;
}): string {
    switch (type) {
        case AggregationType.String:
        case AggregationType.Id:
            return AggregationSubQueries.stringAggregationQuery(matchWherePattern, fieldName, targetAlias);
        case AggregationType.Int:
        case AggregationType.BigInt:
        case AggregationType.Float:
            return AggregationSubQueries.numberAggregationQuery(matchWherePattern, fieldName, targetAlias);
        case AggregationType.DateTime:
            return AggregationSubQueries.dateTimeAggregationQuery(matchWherePattern, fieldName, targetAlias);
        default:
            return AggregationSubQueries.defaultAggregationQuery(matchWherePattern, fieldName, targetAlias);
    }
}
