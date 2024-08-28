import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";



// Create a VPC with only public subnets and no NAT gateways
const vpc = new awsx.ec2.Vpc("myVPC", {
    numberOfAvailabilityZones: 2,
    cidrBlock: "10.1.0.0/16",  // Changed the VPC CIDR block
    subnetSpecs: [
        {
            type: awsx.ec2.SubnetType.Public,
            name: "public",
            cidrMask: 24,
        },
    ],
    natGateways: {
        strategy: awsx.ec2.NatGatewayStrategy.None,
    },
    subnetStrategy: awsx.ec2.SubnetAllocationStrategy.Auto,
});

// Create a security group for Redis
const redisSecurityGroup = new aws.ec2.SecurityGroup("redisSecurityGroup", {
    vpcId: vpc.vpcId,
    ingress: [
        { protocol: "tcp", fromPort: 6379, toPort: 6379, cidrBlocks: ["0.0.0.0/0"] },
    ],
});

// Create a Redis cluster
const redisSubnetGroup = new aws.elasticache.SubnetGroup("redisSubnetGroup", {
    subnetIds: vpc.publicSubnetIds,
});

const redisCluster = new aws.elasticache.Cluster("myRedisCluster", {
    engine: "redis",
    engineVersion: "7.0",
    nodeType: "cache.t3.micro",
    numCacheNodes: 1,
    parameterGroupName: "default.redis7",
    port: 6379,
    subnetGroupName: redisSubnetGroup.name,
    securityGroupIds: [redisSecurityGroup.id],
});

// Create a Lambda function with basic execution role
const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "lambda.amazonaws.com",
            },
        }],
    }),
});

// Attach the AWSLambdaBasicExecutionRole policy
const lambdaRolePolicy = new aws.iam.RolePolicyAttachment("lambdaRolePolicy", {
    role: lambdaRole,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
});

const lambda = new aws.lambda.Function("myLambda", {
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
            const Redis = require('ioredis');
            const redis = new Redis(process.env.REDIS_ENDPOINT);

            exports.handler = async (event) => {
                const cacheKey = event.queryStringParameters?.key || 'default';
                let result = await redis.get(cacheKey);

                if (!result) {
                    result = new Date().toISOString();
                    await redis.set(cacheKey, result, 'EX', 60);  // Cache for 60 seconds
                }

                return {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'max-age=60',  // CloudFront caching
                    },
                    body: JSON.stringify({ result, cached: !!result }),
                };
            };
        `),
    }),
    handler: "index.handler",
    runtime: "nodejs20.x",
    role: lambdaRole.arn,
    environment: {
        variables: {
            REDIS_ENDPOINT: redisCluster.cacheNodes[0].address,
        },
    },
});

// Create an API Gateway
const api = new aws.apigateway.RestApi("myApi");

const apiResource = new aws.apigateway.Resource("myApiResource", {
    restApi: api.id,
    parentId: api.rootResourceId,
    pathPart: "cache",
});

const apiMethod = new aws.apigateway.Method("myApiMethod", {
    restApi: api.id,
    resourceId: apiResource.id,
    httpMethod: "GET",
    authorization: "NONE",
});

const apiIntegration = new aws.apigateway.Integration("myApiIntegration", {
    restApi: api.id,
    resourceId: apiResource.id,
    httpMethod: apiMethod.httpMethod,
    integrationHttpMethod: "POST",
    type: "AWS_PROXY",
    uri: lambda.invokeArn,
});

const apiDeployment = new aws.apigateway.Deployment("myApiDeployment", {
    restApi: api.id,
    stageName: "prod",
}, { dependsOn: [apiMethod, apiIntegration] });

// Create a CloudFront distribution
const cloudfrontDistribution = new aws.cloudfront.Distribution("myCloudfrontDistribution", {
    enabled: true,
    defaultCacheBehavior: {
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],
        targetOriginId: api.id,
        forwardedValues: {
            queryString: true,
            headers: ["Origin"],
            cookies: {
                forward: "none",
            },
        },
        viewerProtocolPolicy: "redirect-to-https",
        minTtl: 0,
        defaultTtl: 60,
        maxTtl: 300,
    },
    origins: [{
        domainName: pulumi.interpolate`${api.id}.execute-api.${aws.config.region}.amazonaws.com`,
        originId: api.id,
        customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "https-only",
            originSslProtocols: ["TLSv1.2"],  // Add this line
        },
    }],
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        cloudfrontDefaultCertificate: true,
    },
});

// Export the CloudFront URL
export const cloudfrontUrl = cloudfrontDistribution.domainName;