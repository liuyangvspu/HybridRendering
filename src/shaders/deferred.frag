#version 450

#extension GL_GOOGLE_include_directive : require

#include "common.glsl"

#define INDIRECT_INTENSITY 0.3f

// ------------------------------------------------------------------------
// INPUTS -----------------------------------------------------------------
// ------------------------------------------------------------------------

layout(location = 0) in vec2 FS_IN_TexCoord;

// ------------------------------------------------------------------------
// OUTPUTS ----------------------------------------------------------------
// ------------------------------------------------------------------------

layout(location = 0) out vec4 FS_OUT_Color;

// ------------------------------------------------------------------------
// CONSTANTS --------------------------------------------------------------
// ------------------------------------------------------------------------

const float Pi       = 3.141592654;
const float CosineA0 = Pi;
const float CosineA1 = (2.0 * Pi) / 3.0;
const float CosineA2 = Pi * 0.25;

// ------------------------------------------------------------------------
// DESCRIPTOR SETS --------------------------------------------------------
// ------------------------------------------------------------------------

layout(set = 0, binding = 0) uniform sampler2D s_GBuffer1; // RGB: Albedo, A: Roughness
layout(set = 0, binding = 1) uniform sampler2D s_GBuffer2; // RGB: Normal, A: Metallic
layout(set = 0, binding = 2) uniform sampler2D s_GBuffer3; // RG: Motion Vector, BA: -
layout(set = 0, binding = 3) uniform sampler2D s_GBufferDepth;

layout(set = 1, binding = 0) uniform sampler2D s_Shadow;

layout(set = 2, binding = 0) uniform PerFrameUBO
{
    mat4  view_inverse;
    mat4  proj_inverse;
    mat4  view_proj_inverse;
    mat4  prev_view_proj;
    mat4  view_proj;
    vec4  cam_pos;
    Light light;
}
ubo;

layout(set = 3, binding = 0) uniform sampler2D s_IrradianceSH;
layout(set = 3, binding = 1) uniform samplerCube s_Prefiltered;
layout(set = 3, binding = 2) uniform sampler2D s_BRDF;

// ------------------------------------------------------------------------
// FUNCTIONS --------------------------------------------------------------
// ------------------------------------------------------------------------

struct SH9
{
    float c[9];
};

// ------------------------------------------------------------------

struct SH9Color
{
    vec3 c[9];
};

// ------------------------------------------------------------------

void project_onto_sh9(in vec3 dir, inout SH9 sh)
{
    // Band 0
    sh.c[0] = 0.282095;

    // Band 1
    sh.c[1] = -0.488603 * dir.y;
    sh.c[2] = 0.488603 * dir.z;
    sh.c[3] = -0.488603 * dir.x;

    // Band 2
    sh.c[4] = 1.092548 * dir.x * dir.y;
    sh.c[5] = -1.092548 * dir.y * dir.z;
    sh.c[6] = 0.315392 * (3.0 * dir.z * dir.z - 1.0);
    sh.c[7] = -1.092548 * dir.x * dir.z;
    sh.c[8] = 0.546274 * (dir.x * dir.x - dir.y * dir.y);
}

// ------------------------------------------------------------------

vec3 evaluate_sh9_irradiance(in vec3 direction)
{
    SH9 basis;

    project_onto_sh9(direction, basis);

    basis.c[0] *= CosineA0;
    basis.c[1] *= CosineA1;
    basis.c[2] *= CosineA1;
    basis.c[3] *= CosineA1;
    basis.c[4] *= CosineA2;
    basis.c[5] *= CosineA2;
    basis.c[6] *= CosineA2;
    basis.c[7] *= CosineA2;
    basis.c[8] *= CosineA2;

    vec3 color = vec3(0.0);

    for (int i = 0; i < 9; i++)
        color += texelFetch(s_IrradianceSH, ivec2(i, 0), 0).rgb * basis.c[i];

    color.x = max(0.0, color.x);
    color.y = max(0.0, color.y);
    color.z = max(0.0, color.z);

    return color / Pi;
}

// ------------------------------------------------------------------

float distribution_ggx(vec3 N, vec3 H, float roughness)
{
    float a      = roughness * roughness;
    float a2     = a * a;
    float NdotH  = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;

    float nom   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom       = Pi * denom * denom;

    return nom / max(EPSILON, denom);
}

// ------------------------------------------------------------------

vec3 world_position_from_depth(vec2 tex_coords, float ndc_depth)
{
    // Take texture coordinate and remap to [-1.0, 1.0] range.
    vec2 screen_pos = tex_coords * 2.0 - 1.0;

    // // Create NDC position.
    vec4 ndc_pos = vec4(screen_pos, ndc_depth, 1.0);

    // Transform back into world position.
    vec4 world_pos = ubo.view_proj_inverse * ndc_pos;

    // Undo projection.
    world_pos = world_pos / world_pos.w;

    return world_pos.xyz;
}

// ------------------------------------------------------------------

float geometry_schlick_ggx(float NdotV, float roughness)
{
    float r = (roughness + 1.0);
    float k = (r * r) / 8.0;

    float nom   = NdotV;
    float denom = NdotV * (1.0 - k) + k;

    return nom / max(EPSILON, denom);
}

// ------------------------------------------------------------------

float geometry_smith(vec3 N, vec3 V, vec3 L, float roughness)
{
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2  = geometry_schlick_ggx(NdotV, roughness);
    float ggx1  = geometry_schlick_ggx(NdotL, roughness);

    return ggx1 * ggx2;
}
// ----------------------------------------------------------------------------
vec3 fresnel_schlick(float cosTheta, vec3 F0)
{
    return F0 + (1.0 - F0) * pow(max(1.0 - cosTheta, 0.0), 5.0);
}
// ----------------------------------------------------------------------------
vec3 fresnel_schlick_roughness(float cosTheta, vec3 F0, float roughness)
{
    return F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(max(1.0 - cosTheta, 0.0), 5.0);
}

// ------------------------------------------------------------------------
// MAIN -------------------------------------------------------------------
// ------------------------------------------------------------------------

void main()
{
    vec4 g_buffer_data_1 = texture(s_GBuffer1, FS_IN_TexCoord);
    vec4 g_buffer_data_2 = texture(s_GBuffer2, FS_IN_TexCoord);
    vec4 g_buffer_data_3 = texture(s_GBuffer3, FS_IN_TexCoord);
    vec4 shadow_ao_data  = texture(s_Shadow, FS_IN_TexCoord);

    const vec3  world_pos  = world_position_from_depth(FS_IN_TexCoord, texture(s_GBufferDepth, FS_IN_TexCoord).r);
    const vec3  albedo     = g_buffer_data_1.rgb;
    const float roughness  = g_buffer_data_1.a;
    const float metallic   = g_buffer_data_2.a;
    const float visibility = shadow_ao_data.r;
    const float ao         = shadow_ao_data.g;

    const vec3 N  = g_buffer_data_2.rgb;
    const vec3 Wo = normalize(ubo.cam_pos.xyz - world_pos);
    const vec3 R  = reflect(-Wo, N);

    vec3 F0 = mix(vec3(0.04f), albedo, metallic);

    vec3 direct   = vec3(0.0f);
    vec3 indirect = vec3(0.0f);

    // Direct Lighting
    {
        Light light = ubo.light;

        vec3 Li = light_color(light) * light_intensity(light);
        vec3 Wi = vec3(0.0f);
        vec3 Wh = normalize(Wo + Wi);

        if (light_type(light) == LIGHT_DIRECTIONAL)
            Wi = light_direction(light);
        else if (light_type(light) == LIGHT_POINT)
        {
            vec3 to_light        = light_position(light) - world_pos;
            Wi                   = normalize(to_light);
            float light_distance = length(to_light);
            Li *= (1.0f / (light_distance * light_distance));
        }
        else
        {
            Wi                   = light_direction(light);
            vec3  to_light       = light_position(light) - world_pos;
            vec3  light_dir      = normalize(to_light);
            float light_distance = length(to_light);

            float angle_attenuation = dot(light_dir, -light_direction(light));
            angle_attenuation       = smoothstep(light_cos_theta_outer(light), light_cos_theta_inner(light), angle_attenuation);

            Li *= (angle_attenuation / (light_distance * light_distance));
        }

        // Cook-Torrance BRDF
        float NDF = distribution_ggx(N, Wh, roughness);
        float G   = geometry_smith(N, Wo, Wi, roughness);
        vec3  F   = fresnel_schlick(max(dot(Wh, Wo), 0.0), F0);

        vec3  nominator   = NDF * G * F;
        float denominator = 4 * max(dot(N, Wo), 0.0) * max(dot(N, Wi), 0.0); // 0.001 to prevent divide by zero.
        vec3  specular    = nominator / max(EPSILON, denominator);

        // kS is equal to Fresnel
        vec3 kS = F;
        vec3 kD = vec3(1.0) - kS;
        kD *= 1.0 - metallic;

        // scale light by NdotL
        float NdotL = max(dot(N, Wi), 0.0);

        // add to outgoing radiance Lo
        direct += (kD * albedo / M_PI + specular) * Li * NdotL * visibility; // note that we already multiplied the BRDF by the Fresnel (kS) so we won't multiply by kS again
    }

    // Indirect lighting
    vec3 F = fresnel_schlick_roughness(max(dot(N, Wo), 0.0), F0, roughness);

    vec3 kS = F;
    vec3 kD = 1.0 - kS;
    kD *= 1.0 - metallic;

    vec3 irradiance = evaluate_sh9_irradiance(N);
    vec3 diffuse    = irradiance * albedo;

    // sample both the pre-filter map and the BRDF lut and combine them together as per the Split-Sum approximation to get the IBL specular part.
    const float MAX_REFLECTION_LOD = 4.0;
    vec3        prefilteredColor   = textureLod(s_Prefiltered, R, roughness * MAX_REFLECTION_LOD).rgb;
    vec2        brdf               = texture(s_BRDF, vec2(max(dot(N, Wo), 0.0), roughness)).rg;
    vec3        specular           = prefilteredColor * (F * brdf.x + brdf.y);

    indirect = (kD * diffuse + specular) * ao;

    vec3 Li = direct + indirect * INDIRECT_INTENSITY;

    FS_OUT_Color = vec4(Li, 1.0);
}

// ------------------------------------------------------------------------